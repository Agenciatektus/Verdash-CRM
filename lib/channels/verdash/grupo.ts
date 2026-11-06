/** Entrada de mensagem de GRUPO do canal Verdash (separada de `./ingest.ts` pelo teto de 300 linhas). */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { contextoDaMensagem, ehChamada } from "@/lib/grupos/chamada";
import { criarIngestDeGrupoDb, gravarMensagemDeGrupo } from "@/lib/grupos/ingest";

import { pedirPersistenciaDaMidia } from "./gravacao";
import type { VerdashIngestResult } from "./ingest";
import type { VerdashInboundMessage } from "./webhook";

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * 9224 — a mensagem chamou este número? Aprende o `own_lid` (o FZAP não o informa) na primeira
 * mensagem `IsFromMe` de grupo cujo `Sender` é `@lid`, sem sobrescrever outras chaves do metadata.
 * Falha de leitura = `false` (falha fechada: o modo `chamada` não responde sem certeza).
 */
async function chamouEsteNumero(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; payload?: unknown },
  msg: VerdashInboundMessage,
): Promise<boolean> {
  const evt = obj(obj(input.payload).event);
  const sender = obj(evt.Info).Sender;
  const { data } = await admin
    .from("channel_sessions")
    .select("phone_number, metadata")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .maybeSingle();
  const sessao = data as { phone_number: string | null; metadata: Record<string, unknown> | null } | null;
  if (!sessao) return false;
  const meta = obj(sessao.metadata);
  const ownLid = typeof meta.own_lid === "string" ? meta.own_lid : null;

  if (msg.direction === "outbound") {
    const lid = typeof sender === "string" && sender.endsWith("@lid") ? (sender.split("@")[0] ?? "").split(":")[0] : null;
    if (lid && lid !== ownLid) {
      // Atômico (`jsonb_set`): regravar o metadata inteiro desfaria um `disabled`/`ai_gate` gravado no meio.
      await admin.rpc("fn_gravar_own_lid", {
        p_organization_id: input.organizationId,
        p_channel_session_id: input.channelSessionId,
        p_lid: lid,
      });
    }
    return false;
  }

  const ctx = contextoDaMensagem(evt.Message);
  let citouNosso = false;
  if (ctx.citada) {
    const { data: citada } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId)
      .eq("direction", "outbound")
      .eq("external_id", ctx.citada)
      .limit(1);
    citouNosso = (citada?.length ?? 0) > 0;
  }
  return ehChamada(ctx, { phone: sessao.phone_number, lid: ownLid }, citouNosso);
}

/**
 * Mensagem de grupo → `gravarMensagemDeGrupo`, que decide se o grupo está ligado.
 * Edição/apagada e sinais de protocolo de grupo não entram (o balão do grupo não é editável aqui).
 * A mídia do FZAP expira em ~30 min: gravada, pede a persistência igual à conversa individual.
 */
export async function ingerirGrupo(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; payload?: unknown },
  msg: VerdashInboundMessage,
): Promise<VerdashIngestResult> {
  if (msg.ignorar || msg.alteracao) return { status: "ignored", reason: msg.ignorar ?? "alteracao_em_grupo" };
  const anexo = msg.attachments[0];
  const chamada = await chamouEsteNumero(admin, input, msg).catch(() => false);
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
    chamada,
  });
  if (resultado === "duplicada") return { status: "duplicate" };
  if (resultado !== "gravada") return { status: "ignored", reason: resultado };

  const g = gravada as { id: string; conversationId: string } | null;
  if (g && anexo?.url) await pedirPersistenciaDaMidia(admin, input.organizationId, g.conversationId, g.id);
  return { status: "ingested", conversationId: g?.conversationId, messageId: g?.id };
}
