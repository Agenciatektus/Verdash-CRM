/**
 * Consome `media.persist_requested`: baixa o binário da mídia (MediaSource
 * WAHA) e persiste no bucket privado `whatsapp-media`, preenchendo
 * media_storage_path/media_size_bytes na linha de `messages`.
 * Retry/backoff é responsabilidade do drain (`lib/event-log/drain.ts`), não
 * deste handler: aqui só retornamos `status:"error"` em falha. O drain conta
 * `attempts` e dead-letra a partir do próprio `MAX_ATTEMPTS`; espelhamos esse
 * valor localmente (`DRAIN_MAX_ATTEMPTS`) só para saber quando é a ÚLTIMA
 * tentativa que o drain vai permitir e marcar `metadata.media_status =
 * "failed"` na própria mensagem antes do dead-letter (Onda 3 poderá
 * reprocessar).
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapterOpcional,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { caminhoDaMiniatura, gerarMiniatura } from "@/lib/messaging/media/miniatura";
import { mimeDeclaradoParaRotulo, mimeSeguroParaGuardar } from "@/lib/messaging/media/mime-seguro";
import { storagePathFor } from "@/lib/messaging/media/types";
import { leituraDeMidiaLigada } from "@/lib/messaging/media/leitura-da-org";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/supabase/rpc";

export const MEDIA_PERSIST_CONSUMER_KEY = "media_persist_v1";
// Espelha MAX_ATTEMPTS de lib/event-log/drain.ts (não exportado de lá).
// `row.attempts` chega ao handler como a contagem ANTES do incremento do
// drain; o drain dead-letra quando `row.attempts + 1 >= DRAIN_MAX_ATTEMPTS`,
// ou seja, a última tentativa que o drain ainda vai permitir é
// `row.attempts === DRAIN_MAX_ATTEMPTS - 1`.
const DRAIN_MAX_ATTEMPTS = 5;

interface MessageMediaRow {
  channel_session_id: string;
  id: string;
  organization_id: string;
  conversation_id: string;
  media_url: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
  /** Mídia que a própria empresa ENVIOU não é derivada: ninguém precisa ler o que ela mesma mandou. */
  direction?: string | null;
}

export async function persistMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_PERSIST_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    // `channel_session_id` entra no select porque é ele que resolve QUEM baixa.
    // Sem a coluna, o worker não tem como pedir o adapter e voltaria a
    // depender de uma função fixa de um canal só.
    .select(
      "id, organization_id, conversation_id, channel_session_id, media_url, media_mime, media_storage_path, metadata, direction",
    )
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageMediaRow | null;
  // A retenção marcou `metadata.media_status='expired'` (migration 0557): a mídia
  // foi retirada por política, nem `media_url` nem `media_storage_path` devem
  // voltar. NÃO tentar baixar de novo do provedor o que expirou (#1534). Vem
  // ANTES do `!media_url`: a poda anula a `media_url`, e depois dele esta guarda
  // nunca seria alcançada — o detalhe diria "no media_url" em vez do motivo real.
  if (msg?.metadata?.media_status === "expired") {
    return { consumer_key, status: "skipped", detail: "expired by retention" };
  }
  if (!msg?.media_url) return { consumer_key, status: "skipped", detail: "no media_url" };
  if (msg.media_storage_path) return { consumer_key, status: "skipped", detail: "already stored" };

  /**
   * Grava o estado SÓ se a linha ainda é a que foi lida (compare-and-set, P2-1
   * do @Cassio_SecRev na #75): mesmo `media_url`, ainda sem arquivo e corpo não
   * redigido. A anonimização (LGPD) zera `media_url` e a mídia e troca o corpo
   * pelo sentinela; se ela rodou durante o download, gravar por cima traria de
   * volta o que a cascata apagou. A guarda do corpo é a do upstream (#1991,
   * `isdistinct`, nunca `neq`: mídia sem legenda tem body NULL). Devolve quantas
   * linhas mudaram — 0 é "a linha mudou, não grave nada".
   *
   * `derivacao` (upstream, item 2 da #2171): todo desfecho TERMINAL da derivação
   * grava `media_derived_status` junto do motivo, para a coluna nunca ficar nula
   * quando ninguém mais vai tentar.
   */
  const markStatus = async (
    media_status: "stored" | "failed",
    patch: Record<string, unknown> = {},
    derivacao: { status: "failed" | "skipped"; motivo: string } | null = null,
  ): Promise<number> => {
    const metadata = {
      ...(msg.metadata ?? {}),
      media_status,
      ...(derivacao ? { media_derived_motivo: derivacao.motivo } : {}),
    };
    const { data: gravadas, error: updErr } = await admin
      .from("messages")
      .update({
        metadata,
        ...(derivacao ? { media_derived_status: derivacao.status } : {}),
        ...patch,
      })
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id)
      .eq("media_url", msg.media_url as string)
      .is("media_storage_path", null)
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA)
      .select("id");
    if (updErr) throw new Error(`message update failed: ${updErr.message}`);
    return (gravadas ?? []).length;
  };

  /**
   * O desfecho da DERIVAÇÃO depois que os bytes já foram gravados. Não usa o
   * `markStatus`: o compare-and-set dele exige `media_storage_path` nulo, e
   * depois do `stored` a coluna já está preenchida — a escrita casaria ZERO
   * linhas e a coluna ficaria nula, o silêncio que a #2171 fechou.
   */
  const marcarDerivacao = async (status: "failed" | "skipped", motivo: string): Promise<void> => {
    const { error: updErr } = await admin
      .from("messages")
      .update({
        media_derived_status: status,
        metadata: { ...(msg.metadata ?? {}), media_status: "stored", media_derived_motivo: motivo },
      })
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id)
      // Mesma guarda LGPD do `markStatus`: esta metadata é a foto lida no começo.
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA);
    if (updErr) throw new Error(`message update failed: ${updErr.message}`);
  };

  const isLastAttempt = row.attempts >= DRAIN_MAX_ATTEMPTS - 1;

  let media;
  try {
    // Pelo ADAPTER, não por uma função fixa. Antes esta linha era
    // `fetchWahaMedia(...)` direto: mídia recebida por qualquer outro canal
    // virava linha SEM bytes, e o atendente via "imagem" sem imagem. Medido em
    // produção: 423 persistências no canal por QR, ZERO no intermediado.
    //
    // O worker não pergunta QUAL canal é — o invariante 1 proíbe e o
    // `lint:channels` reprova. Ele pede a sessão, pede o adapter e testa a
    // presença do método.
    const { data: sessao } = await admin
      .from("channel_sessions")
      .select(`provider, ${CHANNEL_SESSION_REF_COLUMNS}`)
      .eq("organization_id", msg.organization_id)
      .eq("id", msg.channel_session_id)
      .maybeSingle();

    // Opcional, e a diferença é exatamente o que o comentário abaixo promete: com
    // `getAdapter`, um canal sem adapter local lançava ANTES de chegar ao guard, caía
    // no `catch` e a mídia virava `failed` — o defeito que não existe, acusado pelo
    // caminho que o guard não alcançava.
    const adapter = getAdapterOpcional(
      ((sessao?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider,
    );
    const sessionRef = sessao ? resolveSessionRef(sessao as unknown as ChannelSessionRef) : null;
    if (!adapter?.fetchInboundMedia || !sessionRef) {
      // Canal que não sabe baixar não é erro: é o estado normal de um canal sem
      // mídia de entrada. Marcar `failed` faria a Central acusar um defeito que
      // não existe.
      // `skipped` + motivo, não nulo: nada mais vai ser tentado para esta
      // linha, e a coluna não pode dizer "ainda estou esperando".
      // Escrita direta: `media_status` não muda aqui (os bytes nunca chegaram,
      // não houve defeito — é o estado normal do canal), e quem muda é só a
      // derivação, que não vai ser tentada de novo.
      const { error: updCanal } = await admin
        .from("messages")
        .update({
          media_derived_status: "skipped",
          metadata: {
            ...(msg.metadata ?? {}),
            media_derived_motivo:
              "o canal desta conversa não expõe download de mídia de entrada, então os bytes nunca vão chegar ao Storage",
          },
        })
        .eq("id", msg.id)
        .eq("organization_id", msg.organization_id)
        // Mesma guarda LGPD do `markStatus`: esta metadata também é a foto lida.
        .filter("body", "isdistinct", MENSAGEM_REDIGIDA);
      if (updCanal) throw new Error(`message update failed: ${updCanal.message}`);
      return { consumer_key, status: "skipped", detail: "canal_sem_midia_de_entrada" };
    }

    media = await adapter.fetchInboundMedia({
      organizationId: msg.organization_id,
      sessionRef,
      url: msg.media_url,
      hintMime: msg.media_mime,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isLastAttempt) {
      logger.error("[media-persist] download failed permanently", { message_id: msg.id, detail });
      await markStatus("failed", {}, {
        status: "failed",
        motivo: `não consegui baixar a mídia em todas as tentativas: ${detail}`,
      });
    }
    return { consumer_key, status: "error", detail };
  }

  // O mime que se GUARDA não é o que o CDN declarou às cegas (P2-3 do Cassio
  // na #79): fora de imagem (sem SVG), áudio, vídeo e PDF, vira
  // `application/octet-stream` — um `text/html` ou SVG guardado como veio
  // abriria como página no navegador do atendente. A extensão do caminho segue
  // o declarado (o rótulo "DOCX" da tela); o tipo servido, o seguro.
  const mimeGuardado = mimeSeguroParaGuardar(media.mime);
  const path = storagePathFor(msg.organization_id, msg.conversation_id, msg.id, media.mime);
  const { error: uploadErr } = await admin.storage
    .from("whatsapp-media")
    .upload(path, media.buffer, { contentType: mimeGuardado, upsert: true });
  if (uploadErr) {
    if (isLastAttempt) {
      logger.error("[media-persist] upload failed permanently", {
        message_id: msg.id,
        detail: uploadErr.message,
      });
      await markStatus("failed", {}, {
        status: "failed",
        motivo: `não consegui salvar a mídia no Storage em todas as tentativas: ${uploadErr.message}`,
      });
    }
    return { consumer_key, status: "error", detail: uploadErr.message };
  }

  // MINIATURA (migration 9033): a lista mostra a imagem a ~256 px, e baixar a
  // original para isso é desperdício. Falha aqui NÃO derruba a persistência:
  // sem miniatura a tela usa a original, e o retroativo cobre depois.
  const miniaturaPath = await salvarMiniatura(admin, msg, media.buffer, mimeGuardado);

  const gravadas = await markStatus("stored", {
    media_storage_path: path,
    media_size_bytes: media.buffer.byteLength,
    // A COLUNA guarda o mime declarado (só o tipo base, curto): é o rótulo do
    // arquivo na tela ("DOCX"). O OBJETO no storage leva o seguro, e a rota e a
    // lista decidem exibir x baixar pelo seguro, recalculado da coluna — nunca
    // pela coluna crua (P2-3 do Cassio na #83).
    media_mime: mimeDeclaradoParaRotulo(media.mime),
    ...(miniaturaPath ? { media_thumb_path: miniaturaPath } : {}),
    // O canal não sabia o tipo (story, post, reel compartilhado): quem decide é
    // o mime do que de fato chegou. Sem isto, um vídeo apareceria como imagem
    // quebrada.
    ...(msg.metadata?.tipo_pelo_mime === true ? { type: tipoPeloMime(mimeGuardado) } : {}),
  });
  if (gravadas === 0) {
    // A linha mudou durante o download: anonimizada, apagada, ou OUTRA execução
    // deste mesmo evento já gravou (o drain reenfileira evento parado em
    // `processing` > 10 min, e o caminho é determinístico — as duas sobem no
    // MESMO objeto). Por isso se RELÊ a linha e só sai o que ela não aponta:
    // apagar às cegas tiraria do bucket a mídia que a outra execução acabou de
    // referenciar (P2-A do @Cassio_SecRev na #75). Na corrida com a LGPD a
    // linha não aponta para nada, e os dois objetos saem.
    const { data: atual, error: releituraErr } = await admin
      .from("messages")
      .select("media_storage_path, media_thumb_path, body")
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id)
      .maybeSingle();
    if (releituraErr) {
      // Sem saber o que a linha aponta, apagar é o lado caro de errar: o objeto
      // fica, e o varredor de órfãos o leva se ninguém o referenciar.
      return { consumer_key, status: "error", detail: `releitura falhou: ${releituraErr.message}` };
    }
    const referenciados = new Set(
      [atual?.media_storage_path, (atual as { media_thumb_path?: string | null } | null)?.media_thumb_path].filter(
        (c): c is string => !!c,
      ),
    );
    const recemSubidos = (miniaturaPath ? [path, miniaturaPath] : [path]).filter((c) => !referenciados.has(c));
    if (recemSubidos.length === 0) {
      return { consumer_key, status: "skipped", detail: "outra_execucao_ja_gravou" };
    }
    const { error: removeErr } = await admin.storage.from("whatsapp-media").remove(recemSubidos);
    if (removeErr) {
      logger.error("[media-persist] objetos sem dono não removidos", {
        message_id: msg.id,
        detail: removeErr.message,
      });
    }
    // A anonimização é a causa que o upstream nomeia (`message_redacted`); as
    // outras (outra execução já gravou) ficam no
    // motivo genérico.
    const redigida = !atual || (atual as { body?: string | null }).body === MENSAGEM_REDIGIDA;
    return {
      consumer_key,
      status: "skipped",
      detail: redigida ? "message_redacted" : "linha_mudou_durante_o_download",
    };
  }

  // Mídia ENVIADA pela própria empresa (foto de produto, áudio do atendente,
  // arquivo do agente) não é derivada: o agente não precisa interpretar o que a
  // empresa mesma mandou. Medido em produção: ~2/3 das derivações mortas numa
  // loja eram dela. A mídia FICA persistida; só a leitura pela IA é pulada.
  if (msg.direction === "outbound") {
    await marcarDerivacao("skipped", "mídia enviada pela própria empresa não é lida pela IA");
    return { consumer_key, status: "ok" };
  }

  // A empresa desligou a leitura de mídia pela IA (Agente de IA → Provedores).
  // Só um `false` gravado desliga; erro de leitura segue como ligada — ver
  // `lib/messaging/media/leitura-da-org.ts`.
  if ((await leituraDeMidiaLigada(admin, msg.organization_id)) === false) {
    await marcarDerivacao("skipped", "a leitura de mídia pela IA está desligada nesta empresa");
    return { consumer_key, status: "ok" };
  }

  // Grupo nunca é derivado: a IA não serve grupos, e derivar custaria visão/
  // transcrição PAGA sem consumidor nenhum do outro lado — ninguém leria "o
  // agente não conseguiu ler o que o cliente mandou" numa conversa que a IA
  // nunca participa. A mídia FICA persistida (Storage, para quem abrir a
  // conversa na tela); só a derivação é pulada.
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("is_group")
    .eq("id", msg.conversation_id)
    .eq("organization_id", msg.organization_id)
    .maybeSingle();
  if (convErr) {
    // Fecha FECHADO, não aberto: sem saber se a conversa é de grupo, o erro
    // caro é pedir uma derivação PAGA (visão/transcrição) por engano numa
    // conversa de grupo — não pedir e alguém reprocessar à mão depois é o
    // lado barato de errar. A mídia já está `stored`; só a derivação fica de
    // fora desta rodada.
    logger.warn("[media-persist] leitura de conversations.is_group falhou — derivação NÃO pedida", {
      organization_id: msg.organization_id,
      conversation_id: msg.conversation_id,
      detail: convErr.message,
    });
    await marcarDerivacao(
      "failed",
      `não consegui verificar se a conversa é de grupo, então a derivação não foi pedida: ${convErr.message}`,
    );
    return { consumer_key, status: "ok" };
  }
  const isGroup = Boolean((conv as { is_group?: boolean | null } | null)?.is_group);

  if (!isGroup) {
    // Dispara a derivação textual (Onda 3) — fire-and-forget, mesmo padrão do
    // resto do repo: falha de emit não reverte a persistência já concluída.
    const { error: emitErr } = await rpc(admin, "emit_event", {
      p_event_type: "media.derive_requested",
      p_entity_kind: "message",
      p_entity_id: msg.id,
      p_payload: { message_id: msg.id },
      p_metadata: { source: "media_persist" },
      p_organization_id: msg.organization_id,
    });
    if (emitErr) {
      logger.warn("[media-persist] emit_event failed (non-blocking)", { message_id: msg.id, detail: emitErr.message });
      // O evento NÃO saiu: ninguém vai pedir a derivação, e deixar a coluna
      // nula aqui é o mesmo silêncio do resto da #2171.
      await marcarDerivacao("failed", `não consegui pedir a derivação textual da mídia: ${emitErr.message}`);
    }
  }

  return { consumer_key, status: "ok" };
}

/**
 * Gera e grava a miniatura da imagem. Devolve o caminho, ou `null` quando não há
 * miniatura (tipo sem miniatura, imagem já pequena, `sharp` ausente, falha de
 * upload) — e nesse caso a tela usa a original.
 */
async function salvarMiniatura(
  admin: ReturnType<typeof createAdminClient>,
  msg: Pick<MessageMediaRow, "id" | "organization_id" | "conversation_id">,
  original: Uint8Array,
  mime: string,
): Promise<string | null> {
  try {
    const miniatura = await gerarMiniatura(original, mime);
    if (!miniatura) return null;
    const caminho = caminhoDaMiniatura(msg.organization_id, msg.conversation_id, msg.id);
    const { error } = await admin.storage
      .from("whatsapp-media")
      .upload(caminho, miniatura, { contentType: "image/webp", upsert: true });
    if (error) {
      logger.warn("[media-persist] miniatura não subiu (a tela usa a original)", {
        message_id: msg.id,
        detail: error.message,
      });
      return null;
    }
    return caminho;
  } catch (err) {
    logger.warn("[media-persist] miniatura não gerada (a tela usa a original)", {
      message_id: msg.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** O tipo da linha pelo mime do download — o vocabulário do CHECK de `messages.type`. */
export function tipoPeloMime(mime: string): "image" | "video" | "audio" | "document" {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  return "document";
}
