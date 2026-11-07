/**
 * Eventos de ESTADO do chat (`Archive`, `Pin`) do FZAP: espelham arquivado e
 * fixado do WhatsApp em `channel_session_group_directory`. Nunca viram mensagem.
 *
 * O FZAP não tem rota para LER arquivado/fixado. O filtro do webhook descarta `Archive`/`Pin`
 * (só aceita a categoria `AppState`), então o caminho real é a mutação crua do whatsmeow:
 * `{Index: ["archive"|"pin_v1", jid], archiveChatAction|pinAction, timestamp}` (o SyncActionValue vem
 * embutido no evento, então os campos sobem de nível; payload real lido em 07/11).
 * `Archive`/`Pin` seguem aceitos por tolerância. O que não casar vai para o log com o `type` e as
 * CHAVES (nunca valores).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { tipoDoEvento } from "./webhook";

const TIPOS = new Set(["Archive", "Pin", "AppState"]);
// Índices de mutação do whatsmeow que interessam; o resto do AppState (mute, etiqueta...) é ignorado calado.
const INDICES = new Set(["archive", "pin_v1"]);

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
  if (tipoDoEvento(payload) === "AppState") return lerAppState(ev);
  const jid = [ev.JID, ev.jid, ev.Chat, ev.chat].find((v) => typeof v === "string" && v.endsWith("@g.us")) as string | undefined;
  if (!jid) return null;
  const acao = obj(ev.Action);
  const bool = (...v: unknown[]) => v.find((x) => typeof x === "boolean") as boolean | undefined;
  const archived = bool(acao.archived, acao.Archived, ev.archived, ev.Archived);
  const pinned = bool(acao.pinned, acao.Pinned, ev.pinned, ev.Pinned);
  if (archived === undefined && pinned === undefined) return null;
  return { jid, ...(archived !== undefined && { archived }), ...(pinned !== undefined && { pinned }) };
}

function lerAppState(ev: Record<string, unknown>): EstadoDeGrupo | null {
  const indice = ev.Index ?? ev.index;
  if (!Array.isArray(indice)) return null;
  const [acao, jid] = indice;
  if (typeof jid !== "string" || !jid.endsWith("@g.us")) return null;
  // Forma real: promovida. A aninhada fica por tolerância.
  const valor = obj(ev.SyncActionValue ?? ev.syncActionValue ?? ev);
  const flag = (o: unknown, k: string) => {
    const v = obj(o)[k];
    return typeof v === "boolean" ? v : undefined;
  };
  if (acao === "archive") {
    const archived = flag(valor.archiveChatAction ?? valor.ArchiveChatAction, "archived");
    return archived === undefined ? null : { jid, archived };
  }
  if (acao === "pin_v1") {
    const pinned = flag(valor.pinAction ?? valor.PinAction, "pinned");
    return pinned === undefined ? null : { jid, pinned };
  }
  return null;
}

/** AppState de outra ação (mute, etiqueta, lido...) ou de chat que não é grupo: sem log. */
function appStateSemInteresse(payload: unknown): boolean {
  if (tipoDoEvento(payload) !== "AppState") return false;
  const ev = obj(obj(payload).event);
  const indice = ev.Index ?? ev.index;
  return !Array.isArray(indice) || !INDICES.has(indice[0]) || !String(indice[1] ?? "").endsWith("@g.us");
}

export async function aplicarEstadoDeGrupo(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; payload: unknown },
): Promise<{ status: "updated" | "ignored"; reason: string }> {
  if (appStateSemInteresse(input.payload)) return { status: "ignored", reason: "estado_sem_interesse" };
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
