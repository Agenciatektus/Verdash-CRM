/** Entrada de mensagem de GRUPO do canal Verdash (separada de `./ingest.ts` pelo teto de 300 linhas). */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { criarIngestDeGrupoDb, gravarMensagemDeGrupo } from "@/lib/grupos/ingest";

import { pedirPersistenciaDaMidia } from "./gravacao";
import type { VerdashIngestResult } from "./ingest";
import type { VerdashInboundMessage } from "./webhook";

/**
 * Mensagem de grupo → `gravarMensagemDeGrupo`, que decide se o grupo está ligado.
 * Edição/apagada e sinais de protocolo de grupo não entram (o balão do grupo não é editável aqui).
 * A mídia do FZAP expira em ~30 min: gravada, pede a persistência igual à conversa individual.
 */
export async function ingerirGrupo(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
  msg: VerdashInboundMessage,
): Promise<VerdashIngestResult> {
  if (msg.ignorar || msg.alteracao) return { status: "ignored", reason: msg.ignorar ?? "alteracao_em_grupo" };
  const anexo = msg.attachments[0];
  // O insert já devolve o id; guardá-lo aqui evita reler a mensagem para pedir a mídia.
  const db = criarIngestDeGrupoDb(admin);
  let gravada: { id: string; conversationId: string } | null = null;
  const resultado = await gravarMensagemDeGrupo({
    ...db,
    async inserirMensagem(row) {
      const r = await db.inserirMensagem(row);
      if (r.messageId) gravada = { id: r.messageId, conversationId: String(row.conversation_id) };
      return r;
    },
  }, {
    organizationId: input.organizationId,
    channelSessionId: input.channelSessionId,
    groupChatId: msg.chat,
    direction: msg.direction,
    externalId: msg.externalId,
    type: msg.tipo,
    body: msg.text ?? anexo?.caption ?? null,
    mediaUrl: anexo?.url ?? null,
    mediaMime: anexo?.mime ?? null,
    temMidia: !!anexo,
    sentAt: msg.sentAt ?? new Date().toISOString(),
    // Quem falou: o `Sender` do grupo. Na saída é o dono do número, e o rótulo fica de fora.
    remetente:
      msg.direction === "inbound" && (msg.identity.displayName || msg.identity.phone || msg.identity.lid)
        ? {
            name: msg.identity.displayName?.trim().slice(0, 200) || null,
            phone: msg.identity.phone ? canonicalPhoneBR(msg.identity.phone) : null,
            lid: msg.identity.lid,
          }
        : null,
    rawType: msg.tipo,
  });
  if (resultado === "duplicada") return { status: "duplicate" };
  if (resultado !== "gravada") return { status: "ignored", reason: resultado };

  const g = gravada as { id: string; conversationId: string } | null;
  if (g && anexo?.url) await pedirPersistenciaDaMidia(admin, input.organizationId, g.conversationId, g.id);
  return { status: "ingested", conversationId: g?.conversationId, messageId: g?.id };
}
