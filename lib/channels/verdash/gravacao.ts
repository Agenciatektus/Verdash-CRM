/**
 * A gravação da mensagem do canal Verdash: o INSERT, o carimbo da conversa e o
 * pedido de persistência da mídia. Separado de `./ingest.ts` só por tamanho;
 * as decisões (o que é mensagem, de quem, se altera ou insere) ficam lá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { mensagemJaRecebida } from "@/lib/messaging/mensagem-ja-recebida";

import { logger } from "@/lib/logger";

import type { VerdashInboundMessage } from "./webhook";
import { rpc } from "@/lib/supabase/rpc";

/**
 * Carimba a conversa com o que acabou de chegar.
 *
 * Não é cosmético: `last_inbound_at` é a fonte da janela de 24h. Sem esta
 * chamada o selo diz "o cliente nunca escreveu" numa conversa em que ele acabou
 * de escrever, o guardrail do agente trata toda conversa como fechada, e o
 * contador de não lidas fica em zero com mensagem nova. Três sintomas sem
 * relação aparente, uma linha ausente — medido no canal irmão.
 *
 * Não carimba no `duplicate`: a reentrega é a MESMA mensagem, e somar de novo
 * inflaria o contador a cada reenvio.
 */
export async function marcarConversa(
  admin: SupabaseClient,
  conversationId: string,
  msg: VerdashInboundMessage,
): Promise<void> {
  const { error } = await rpc(admin, "fn_mark_conversation_message", {
    p_conv: conversationId,
    p_direction: msg.direction,
    p_preview: (msg.text ?? rotuloDoAnexo(msg)).slice(0, 200),
    // A hora em que o cliente ESCREVEU, não a em que o webhook chegou: numa
    // reentrega atrasada as duas diferem por horas, e a ordem da lista e o
    // cálculo da janela dependem da primeira.
    p_at: msg.sentAt ?? new Date().toISOString(),
  });
  if (error) {
    // Não derruba a ingestão: a mensagem já está gravada, e perder o carimbo é
    // ruim — mas MUITO melhor que devolver 500 e fazer o FZAP reenviar tudo.
    logger.warn("[verdash] carimbo da conversa falhou", {
      conversationId,
      detail: error.message,
    });
  }
}

/** "[Imagem]" e afins, para a prévia de mídia sem legenda não ficar vazia. */
function rotuloDoAnexo(msg: VerdashInboundMessage): string {
  switch (msg.attachments[0]?.type) {
    case "image":
      return "[Imagem]";
    case "video":
      return "[Vídeo]";
    case "audio":
      return "[Áudio]";
    case "sticker":
      return "[Figurinha]";
    case "document":
      return "[Documento]";
    default:
      return "";
  }
}

/**
 * Pede a persistência dos bytes do anexo.
 *
 * Mesmo evento e mesmo payload que os canais irmãos emitem — o consumidor é o
 * único (`workers/media-persist-worker.ts`), e um payload diferente por canal
 * faria o worker adivinhar de quem veio.
 *
 * Best-effort: a mensagem já está gravada e visível. Derrubar a ingestão aqui
 * devolveria 500 ao FZAP, que reenviaria tudo — trocaria uma mídia faltando por
 * uma tempestade de reentregas.
 */
export async function pedirPersistenciaDaMidia(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const { error } = await rpc(admin, "emit_event", {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: conversationId },
    p_metadata: { source: "verdash_webhook" },
    p_organization_id: organizationId,
  });
  if (error) {
    logger.warn("[verdash] emit media.persist_requested falhou", {
      messageId,
      detail: error.message,
    });
  }
}

export async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: VerdashInboundMessage;
  },
): Promise<string | "duplicate"> {
  const { msg } = input;
  // Reentrega: a linha já existe. Sai ANTES do INSERT para não rodar os
  // gatilhos de `messages` à toa (o 23505 da constraint deferível só viria no
  // COMMIT). O 23505 abaixo segue sendo a rede da corrida.
  if (await mensagemJaRecebida(admin, input.organizationId, msg.externalId)) return "duplicate";
  const anexo = msg.attachments[0];

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: msg.externalId,
      // A SAÍDA também entra. Descartar o que é `fromMe` esconderia do
      // histórico toda mensagem mandada do celular do operador ou pela própria
      // Verdash — e o cliente veria metade da conversa. A duplicação que se
      // temeria já está resolvida pelo `unique (organization_id, external_id)`,
      // que devolve 23505 no eco do nosso próprio envio.
      direction: msg.direction,
      // Toda linha nascida do webhook veio de FORA do CRM. O default da coluna
      // é `'crm'` e ele mente aqui. Não é cosmético: as funções de fricção
      // contam SÓ `external_device` (sem isto o painel leria "zero atendimento
      // por fora" com o operador respondendo o dia inteiro pelo celular), e o
      // filtro de eco do próprio envio depende deste valor.
      sent_via: "external_device",
      status: msg.direction === "outbound" ? "sent" : "delivered",
      // Nunca `text` vazio por omissão: local, contato e reação têm tipo próprio,
      // e o que não sabemos ler leva `metadata.tipo_nao_suportado`.
      type: msg.tipo,
      body: msg.text ?? anexo?.caption ?? null,
      // A URL é PONTEIRO, não conteúdo — e expira em ~30 min. Grava aqui para a
      // tela ter o que mostrar agora, e o worker baixa os bytes já.
      ...(anexo?.url ? { media_url: anexo.url, media_mime: anexo.mime } : {}),
      metadata: { ...(anexo ? { provider_attachments: msg.attachments } : {}), ...msg.extra },
      ...(msg.sentAt ? { sent_at: msg.sentAt } : {}),
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique violation em (organization_id, external_id). É o desfecho
  // ESPERADO de uma reentrega, não um erro: tratar como falha faria a rota
  // devolver 500 e o FZAP reenviar de novo, para sempre.
  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`verdash_ingest_insert_failed: ${error?.message ?? "sem id"}`);

  return (data as { id: string }).id;
}
