/**
 * A mensagem do Instagram vira conversa no Inbox.
 *
 * ─── O QUE CHEGA AQUI ──────────────────────────────────────────────────────
 *
 * Não é o webhook da Meta. É o reenvio da plataforma do cliente, que recebe da
 * Meta, responde 200 na hora e enfileira — porque entregar ao CRM na mesma
 * requisição faria um CRM fora do ar virar reentrega da Meta e, persistindo,
 * desabilitar a subscription. Um cliente com o CRM caído derrubaria a ingestão
 * de todos.
 *
 * O envelope é `{ tipo, provider_message_id, ad_id, evento }`, e quem o lê é
 * `lerEventoDoInstagram` — um parser PURO, sem banco, que já existia e já tinha
 * teste. Este arquivo é o que faltava entre ele e o Inbox.
 *
 * ─── A PORTA: A FONTE GOVERNA A ENTRADA ────────────────────────────────────
 *
 * Antes de gravar qualquer coisa, pergunta-se que funil aceita aquela fonte. Se
 * nenhum aceita, NADA acontece: nem contato, nem conversa, nem mensagem, nem
 * lead. É decisão de produto do Peterson, e é mais forte que um filtro de tela
 * — um filtro deixaria a conversa existir, o cliente pagando armazenamento, o
 * agente de IA vendo tudo e o contador de não lidas subindo por algo que
 * ninguém vai ler.
 *
 * ─── COMENTÁRIO APARECE E NÃO VIRA LEAD ────────────────────────────────────
 *
 * Quem comenta "que lindo" num post não pediu atendimento, e virar card
 * encheria o Kanban de ruído para o vendedor limpar na mão. Mas aparece no
 * Inbox, porque alguém precisa responder — pessoa ou IA — e o que não aparece
 * não é respondido. Isso só cabe porque conversa e lead são entidades separadas
 * neste schema: a diferença entre os dois é uma linha (`aplicarEfeitosPosEntrada`
 * roda para Direct e não roda para comentário).
 *
 * ─── O QUE "IGNORAR" SIGNIFICA, E POR QUE É 200 ────────────────────────────
 *
 * Recibo de leitura, evento de tipo desconhecido, payload que não interessa: o
 * parser devolve `ignorar`, e a rota responde 200. Responder erro faria a fila
 * da plataforma reentregar para sempre um evento que nunca vai ser processado —
 * e o recuo dela é de 1 a 25 minutos, então o estrago seria silencioso e
 * contínuo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { mensagemJaRecebida } from "@/lib/messaging/mensagem-ja-recebida";

import { lerEventoDoInstagram, type MensagemDoInstagram } from "./evento";
import { fonteDaEntrada, funilQueAceita } from "@/lib/leads/fontes-do-funil";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import type { InboundWebhookInput, InboundWebhookOutcome } from "../inbound";
import { logger } from "@/lib/logger";
import { ehEcoDeEnvioNosso } from "../eco-de-envio-nosso";
import { rpc } from "@/lib/supabase/rpc";

/**
 * Como a pessoa se chama: o nome do perfil, senão o `@`. `null` só quando o
 * Verdash não conseguiu ler o perfil — aí a próxima mensagem tenta de novo.
 */
function rotuloDoPerfil(msg: MensagemDoInstagram): string | null {
  return msg.nome ?? (msg.username ? `@${msg.username}` : null);
}

/** O título que `nascimento-do-lead` dá ao card quando não sabe o nome. */
const TITULO_SEM_NOME = "Novo contato pelo Instagram";

/**
 * Contato que nasceu sem nome (antes do Verdash anexar o perfil, ou numa
 * consulta que falhou) ganha o nome na próxima mensagem — e o card dele deixa
 * de se chamar "Novo contato pelo Instagram".
 *
 * Os dois `update` só tocam o que está VAZIO ou com o título genérico: nome
 * editado à mão e card renomeado pelo vendedor não são sobrescritos. O card só
 * é renomeado se o CONTATO acabou de ganhar este nome — senão o card levaria o
 * nome do perfil e o contato outro, dado à mão.
 *
 * Contato anonimizado (LGPD) nunca é tocado: o passo 1 da anonimização zera
 * `name` e mantém o IGSID até a cascata, e sem a guarda o `is null` abaixo
 * devolveria o nome real a quem pediu para ser esquecido.
 * Best-effort: falhar aqui não pode derrubar a mensagem do cliente.
 */
async function completarNomeQueFaltava(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  msg: MensagemDoInstagram,
): Promise<void> {
  const nome = rotuloDoPerfil(msg);
  if (!nome) return;
  const { data: preenchido, error } = await admin
    .from("contacts")
    .update({ name: nome, ...(msg.nome ? { display_name: msg.nome } : {}) })
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .eq("is_anonymized", false)
    .is("name", null)
    .select("id");
  if (error || !preenchido?.length) return;
  await admin
    .from("crm_leads")
    .update({ title: nome })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("title", TITULO_SEM_NOME);
}

/**
 * O contato do Instagram é ancorado no IGSID.
 *
 * NÃO reusa `fn_upsert_wa_contact`: aquela RPC ancora em telefone ou no id
 * opaco do WhatsApp, e nenhum dos dois existe aqui. Forçá-la criaria contato
 * sem âncora utilizável — e a segunda mensagem da MESMA pessoa viraria um
 * segundo cadastro.
 *
 * A corrida de duas entregas simultâneas é resolvida pelo índice único parcial
 * `contacts_instagram_igsid_key (organization_id, instagram_igsid) where
 * instagram_igsid is not null and is_merged_into is null`: o segundo insert
 * levanta 23505 e a gente relê. O `where is_merged_into is null` é o que deixa a
 * FUSÃO existir — o perdedor vira lápide, sai do índice, e o vencedor herda.
 *
 * ⚠️ A trigger `trg_identidade_de_instagram_e_do_sistema` RECUSA escrita de
 * `instagram_igsid` por sessão de gente. Esta função roda com o cliente de
 * SERVIÇO, onde `auth.uid()` é nulo e a trava deixa passar. Não tente abrir a
 * escotilha de GUC aqui: ela existe para a fusão de contatos, que precisa
 * escrever a coluna de dentro de uma sessão de usuário.
 */
async function upsertContatoDoInstagram(
  admin: SupabaseClient,
  organizationId: string,
  msg: MensagemDoInstagram,
): Promise<string | null> {
  const existente = await admin
    .from("contacts")
    .select("id, is_anonymized")
    .eq("organization_id", organizationId)
    .eq("instagram_igsid", msg.igsid)
    .is("is_merged_into", null)
    .maybeSingle();
  if (existente.data) {
    const id = existente.data.id as string;
    // Anonimizado (LGPD): a mensagem entra, mas o cadastro não ganha de volta
    // nem @ nem nome. Ver `completarNomeQueFaltava`.
    if (existente.data.is_anonymized) return id;
    // O `@` muda quando a pessoa quer, então ele é atualizado; o IGSID, não.
    // `is null` no filtro seria errado aqui: o handle novo é mais verdadeiro
    // que o antigo, ao contrário do telefone, que alguém pode ter corrigido na
    // tela.
    if (msg.username) {
      await admin
        .from("contacts")
        .update({ instagram_username: msg.username })
        .eq("id", id)
        .eq("organization_id", organizationId);
    }
    await completarNomeQueFaltava(admin, organizationId, id, msg);
    return id;
  }

  const criado = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      instagram_igsid: msg.igsid,
      instagram_username: msg.username,
      name: rotuloDoPerfil(msg),
      // O que o CANAL informou, como o `pushName` do WhatsApp. `name` é a
      // coluna que gente edita; as duas nascem iguais e só `name` muda depois.
      display_name: msg.nome,
    })
    .select("id")
    .maybeSingle();

  if (criado.data) return criado.data.id as string;

  // 23505 = o índice único pegou a corrida. A outra entrega criou a linha entre
  // o nosso select e o nosso insert; reler é o desfecho certo, não erro.
  if (criado.error?.code === "23505") {
    const relido = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("instagram_igsid", msg.igsid)
      .is("is_merged_into", null)
      .maybeSingle();
    return (relido.data?.id as string) ?? null;
  }
  return null;
}

/**
 * Grava a mensagem. `duplicate` é desfecho esperado, não falha.
 *
 * A idempotência é do banco: `unique (organization_id, external_id)`. A fila da
 * plataforma reentrega o que não recebeu 200, então a MESMA mensagem chega mais
 * de uma vez por desenho — tratar isso como erro faria a rota devolver 500 e a
 * fila reentregar de novo, para sempre.
 *
 * UMA LINHA por mensagem do cliente, mesmo com vários anexos (#13). INSERT
 * inbound em `messages` dispara as triggers de atendimento
 * (`trg_reply_inbound_revision`, `trg_demanda_abre_no_inbound`): uma linha por
 * anexo faria UMA mensagem do cliente contar como várias. O primeiro arquivo vai
 * em `media_url` (o worker baixa e guarda); os demais ficam em
 * `metadata.instagram_anexos_extras`, sem linha inbound própria — a tela avisa
 * que a mensagem tinha mais anexos. Permalinks vão em `metadata.instagram_links`.
 */
async function inserirMensagem(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: MensagemDoInstagram;
  },
): Promise<string | "duplicate"> {
  const { msg } = input;
  // Reentrega: a linha já existe. Sai ANTES do INSERT para não rodar os
  // gatilhos de `messages` à toa (o 23505 da constraint deferível só viria no
  // COMMIT). O 23505 abaixo segue sendo a rede da corrida.
  if (await mensagemJaRecebida(admin, input.organizationId, msg.providerMessageId)) return "duplicate";
  const [primeira, ...extras] = msg.anexos.midias;
  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: msg.providerMessageId,
      direction: msg.direcao,
      // Nasceu de FORA do CRM. O default da coluna é `'crm'` e ele mentiria
      // aqui: as funções de fricção contam só `external_device`, e o filtro de
      // eco do próprio envio depende deste valor. No eco (o dono respondeu pelo
      // app do Instagram) vale o mesmo: saiu por fora do CRM.
      sent_via: "external_device",
      status: msg.direcao === "outbound" ? "sent" : "delivered",
      // Com arquivo: o tipo dele (story/post/reel nascem `image` e o worker
      // corrige pelo mime). Sem arquivo: `text`, e a tela mostra o aviso.
      type: primeira ? (primeira.tipoDaMensagem ?? "image") : "text",
      body: msg.texto,
      sent_at: msg.recebidaEm,
      ...(primeira ? { media_url: primeira.url } : {}),
      // POR ONDE esta MENSAGEM entrou. A conversa guarda como ela NASCEU; aqui
      // fica o de cada linha, que é o que distingue o comentário da DM dentro
      // de um mesmo fio.
      metadata: {
        instagram_entrada: msg.entrada,
        // Eco: resposta do dono pelo app do Instagram. Mesma marca do canal
        // Meta, para os relatórios que separam "respondido por humano fora do CRM".
        ...(msg.direcao === "outbound" ? { from_business_app: true } : {}),
        // "Tinha mídia" — é o que faz a tela dizer "Mídia expirada" se o
        // arquivo nunca chegar. Permalink e cartão não contam.
        ...(primeira || msg.anexos.temporaria ? { instagram_tem_anexo: true } : {}),
        ...(primeira ? { instagram_anexo_tipo: primeira.tipoNaMeta } : {}),
        ...(primeira && !primeira.tipoDaMensagem ? { tipo_pelo_mime: true } : {}),
        ...(extras.length > 0
          ? { instagram_anexos_extras: extras.map((a) => ({ tipo: a.tipoNaMeta, url: a.url })) }
          : {}),
        ...(msg.anexos.links.length > 0 ? { instagram_links: msg.anexos.links } : {}),
        ...(msg.anexos.temporaria ? { instagram_anexo_temporario: true } : {}),
        ...(msg.mediaId ? { instagram_media_id: msg.mediaId } : {}),
        ...(msg.adId ? { instagram_ad_id: msg.adId } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) {
    throw new Error(`instagram_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  }
  return (data as { id: string }).id;
}

/**
 * Pede a persistência dos bytes — o MESMO evento e payload dos canais irmãos;
 * o consumidor é um só (`workers/media-persist-worker.ts`). Best-effort: a
 * mensagem já está gravada, e derrubar a ingestão faria a fila reentregar tudo.
 */
async function pedirPersistenciaDaMidia(
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
    p_metadata: { source: "instagram_webhook" },
    p_organization_id: organizationId,
  });
  if (error) {
    logger.warn("[instagram] emit media.persist_requested falhou", { messageId, detail: error.message });
  }
}

export async function instagramInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let corpo: unknown;
  try {
    corpo = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "corpo não é JSON" };
  }

  const leitura = lerEventoDoInstagram(corpo, new Date().toISOString());
  if (!leitura.ok) {
    // `contrato_violado` sobe como erro de contrato — num payload que passou
    // pelo HMAC, campo com tipo errado significa que o fio mudou, e isso quem
    // investiga precisa ver. `ignorar` é 200: evento que nunca será processado
    // não deve voltar pela fila para sempre.
    if (leitura.motivo === "contrato_violado") {
      return { ok: false, code: "contrato_violado", message: leitura.detalhe };
    }
    return { ok: true, body: { status: "ignored", reason: leitura.detalhe } };
  }
  const msg = leitura.mensagem;

  // ── A PORTA ──────────────────────────────────────────────────────────────
  const fonte = fonteDaEntrada("instagram", msg.entrada);
  if (!fonte) return { ok: true, body: { status: "ignored", reason: "entrada_sem_fonte" } };

  // Erro de consulta ESTOURA (é o que `funilQueAceita` faz de propósito): o
  // descarte aqui é definitivo, então "não consegui perguntar" nunca pode virar
  // "ninguém aceita". Estourando, a fila reentrega e a mensagem se salva.
  const pipelineId = await funilQueAceita(admin, input.session.organization_id, fonte);
  if (!pipelineId) {
    return { ok: true, body: { status: "ignored", reason: `fonte_nao_ativada:${fonte}` } };
  }

  const organizationId = input.session.organization_id;
  const channelSessionId = input.session.id;

  const contactId = await upsertContatoDoInstagram(admin, organizationId, msg);
  if (!contactId) return { ok: true, body: { status: "ignored", reason: "contato_nao_resolvido" } };

  const { data: convId, error: convErr } = await admin.rpc("fn_upsert_conversa_do_instagram", {
    p_org: organizationId,
    p_contact: contactId,
    p_session: channelSessionId,
    p_entrada: msg.conversa,
  });
  if (convErr || !convId) return { ok: true, body: { status: "ignored", reason: "conversa_nao_resolvida" } };
  const conversationId = convId as string;

  const messageId = await inserirMensagem(admin, {
    organizationId,
    conversationId,
    contactId,
    channelSessionId,
    msg,
  });
  if (messageId === "duplicate") return { ok: true, body: { status: "duplicate", conversationId } };
  if (msg.anexos.midias.length > 0) {
    await pedirPersistenciaDaMidia(admin, organizationId, conversationId, messageId);
  }

  // Carimba a conversa. Não é cosmético: `last_inbound_at` é a fonte da janela,
  // e sem esta chamada o selo diria "o cliente nunca escreveu" numa conversa em
  // que ele acabou de escrever, o contador de não lidas ficaria em zero com
  // mensagem nova, e o guardrail do agente trataria tudo como fechado.
  await marcarConversaComMensagem(admin, {
    organizationId,
    conversationId,
    direction: msg.direcao,
    // `preview` e string, nao `string | null`: a lista do Inbox precisa de
    // algo escrito. Anexo sem legenda vira o selo, que e o que o operador
    // veria no aplicativo.
    preview: msg.texto ?? (msg.temAnexo ? "[anexo]" : ""),
    at: msg.recebidaEm,
    canal: "instagram",
  });

  // ── ECO: O DONO RESPONDEU PELO APP, NÃO PELO CRM ─────────────────────────
  //
  // Não nasce lead e a IA PARA nesta conversa: uma pessoa assumiu o
  // atendimento por fora, e o agente não pode responder por cima. É o mesmo
  // tratamento do canal Meta (`ingestMetaEcho`). A mensagem já está gravada
  // como `outbound` acima — é isso que separa, na tela, quem enviou.
  //
  // MAS o `message_echoes` do Instagram ecoa TAMBÉM o que o próprio CRM enviou
  // (IA, composer, regra). Se o eco chega antes do `external_id` do envio ser
  // gravado (ou com `mid` diferente), ele não bate no unique e cairia aqui —
  // calando a IA logo depois da própria resposta. A linha fica gravada (gravar
  // é tolerante; `removerEcoDoProprioEnvio` limpa a duplicata depois), mas a
  // pausa só acontece quando NÃO há envio nosso em voo que explique o eco.
  if (msg.direcao === "outbound") {
    const ehNosso = await ehEcoDeEnvioNosso(admin, organizationId, conversationId, {
      corpo: msg.texto,
      midia: msg.anexos.midias.length > 0,
    });
    if (!ehNosso) {
      await pausarIaPorAtendimentoManual(admin, { organizationId, conversationId, canal: "instagram" });
      // Sem PII: só ids, para auditar de onde veio a pausa.
      logger.info("[instagram] eco pausou a IA (resposta fora do CRM)", {
        organization_id: organizationId,
        conversation_id: conversationId,
        external_id: msg.providerMessageId,
      });
    }
    return { ok: true, body: { status: "ingested", conversationId, messageId } };
  }

  // ── A LINHA QUE SEPARA DIRECT DE COMENTÁRIO ──────────────────────────────
  //
  // Direct é pedido de atendimento e vira lead. Comentário não. Os dois
  // aparecem no Inbox — a conversa e a mensagem já estão gravadas acima, e é
  // isso que os torna respondíveis.
  if (msg.conversa === "direct") {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId,
      contactId,
      conversationId,
      messageId,
      channelSessionId,
      texto: msg.texto,
      nomeDoContato: rotuloDoPerfil(msg),
      origem: "instagram_webhook",
      // A REDE, que é o que o card do funil escreve. Literal porque este
      // ingest serve uma rede só — `origem` acima é o transporte, e foi
      // confundir os dois que fez o Direct virar "Novo contato pelo WhatsApp".
      rede: "instagram",
      // O funil veio da FONTE, e não do `is_default`.
      pipelineId,
    });
  }

  return { ok: true, body: { status: "ingested", conversationId, messageId } };
}
