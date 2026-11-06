/**
 * Eventos de ESTADO do chat (`Archive`, `Pin`) do FZAP: espelham arquivado e
 * fixado do WhatsApp em `channel_session_group_directory`. Nunca viram mensagem.
 *
 * O FZAP não tem rota para LER arquivado/fixado, e o formato exato do evento é desconhecido:
 * a leitura é tolerante e o que não casar vai para o log com o `type` e as CHAVES (nunca valores).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { tipoDoEvento } from "./webhook";

// Só os nomes assinados em `conectar.ts`; `AppState` cru não tem JID/Action e não é assinado.
const TIPOS = new Set(["Archive", "Pin"]);

export interface EstadoDeGrupo {
  jid: string;
  archived?: boolean;
  pinned?: boolean;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function ehEventoDeEstado(payload: unknown): boolean {
  const t = tipoDoEvento(payload);
  return t !== null && TIPOS.has(t);
}

/** `null` = formato que não casou (ou chat que não é grupo). */
export function lerEstadoDeGrupo(payload: unknown): EstadoDeGrupo | null {
  const ev = obj(obj(payload).event);
  const jid = [ev.JID, ev.jid, ev.Chat, ev.chat].find((v) => typeof v === "string" && v.endsWith("@g.us")) as string | undefined;
  if (!jid) return null;
  const acao = obj(ev.Action);
  const bool = (...v: unknown[]) => v.find((x) => typeof x === "boolean") as boolean | undefined;
  const archived = bool(acao.archived, acao.Archived, ev.archived, ev.Archived);
  const pinned = bool(acao.pinned, acao.Pinned, ev.pinned, ev.Pinned);
  if (archived === undefined && pinned === undefined) return null;
  return { jid, ...(archived !== undefined && { archived }), ...(pinned !== undefined && { pinned }) };
}

export async function aplicarEstadoDeGrupo(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; payload: unknown },
): Promise<{ status: "updated" | "ignored"; reason: string }> {
  const estado = lerEstadoDeGrupo(input.payload);
  if (!estado) {
    // Só tipo e chaves: o valor pode ser dado de cliente.
    logger.info("[verdash] evento de estado sem formato conhecido", {
      type: tipoDoEvento(input.payload),
      chaves: Object.keys(obj(obj(input.payload).event)).slice(0, 30),
    });
    return { status: "ignored", reason: "estado_formato_desconhecido" };
  }
  const mudanca: Record<string, unknown> = {};
  if (estado.archived !== undefined) {
    mudanca.archived = estado.archived;
    mudanca.archived_changed_at = new Date().toISOString();
  }
  if (estado.pinned !== undefined) mudanca.pinned = estado.pinned;
  // Só atualiza grupo que já está no diretório desta sessão: o evento não cria linha.
  const { data, error } = await admin
    .from("channel_session_group_directory")
    .update(mudanca)
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("group_chat_id", estado.jid)
    .select("group_chat_id");
  if (error) throw new Error("verdash_estado_de_grupo_nao_gravado");
  return data && data.length > 0
    ? { status: "updated", reason: "estado_de_grupo" }
    : { status: "ignored", reason: "estado_grupo_fora_do_diretorio" };
}
