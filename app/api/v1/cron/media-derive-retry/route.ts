/**
 * GET/POST /api/v1/cron/media-derive-retry — reprocessa mídia inbound cuja leitura
 * pela IA falhou (`media_derived_status='failed'`), com teto de 3 reprocessos por
 * mensagem, 10 min entre tentativas, janela de 48 h e lote de 100 por rodada.
 *
 * A regra pura mora em `lib/messaging/media/reprocesso-automatico.ts`. Aqui só se
 * lê, conta (`metadata.derive_retries` + `derive_last_retry_at`) e reemite
 * `media.derive_requested` (source `retry_automatico`), o mesmo evento do
 * reprocesso manual; o handler segue sendo o único que deriva.
 *
 * Organização parada, ou com `settings.midia.leitura_pela_ia=false`, não reemite
 * (o handler marcaria `skipped`, mas nem gastamos o evento).
 * Auth: mesmo contrato dos demais crons. Audita só quando reemitiu algo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { leituraDeMidiaDasSettings } from "@/lib/messaging/media/leitura-da-org";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import {
  descartavelParaSempre,
  JANELA_MS,
  MAX_REPROCESSOS,
  reprocessosFeitos,
  selecionarParaReprocesso,
  type MensagemFalha,
} from "@/lib/messaging/media/reprocesso-automatico";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Leitura maior que o lote: parte do que lemos cai fora pelo intervalo/motivo. */
const SCAN_LIMIT = 500;

export interface ReprocessoResultado {
  examinadas: number;
  reemitidas: number;
  falhas: number;
}

export async function reprocessarMidiasFalhas(
  admin: SupabaseClient,
  requestId: string,
  agora: Date = new Date(),
): Promise<ReprocessoResultado> {
  const desde = new Date(agora.getTime() - JANELA_MS).toISOString();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, created_at, updated_at, metadata")
    .eq("direction", "inbound")
    .eq("media_derived_status", "failed")
    .not("media_storage_path", "is", null)
    .gte("created_at", desde)
    // Esgotadas saem na consulta, senão ocupariam o SCAN_LIMIT para sempre.
    .or("metadata->>derive_retries.is.null,metadata->>derive_retries.lt.3")
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`messages: ${error.message}`);
  const candidatas = (data ?? []) as MensagemFalha[];
  if (candidatas.length === 0) return { examinadas: 0, reemitidas: 0, falhas: 0 };

  const orgIds = [...new Set(candidatas.map((m) => m.organization_id))];
  const { data: orgs, error: erroOrgs } = await admin
    .from("organizations")
    .select("id, status, settings")
    .in("id", orgIds);
  if (erroOrgs) throw new Error(`organizations: ${erroOrgs.message}`);
  const elegiveis = new Set(
    ((orgs ?? []) as Array<{ id: string; status: string; settings: unknown }>)
      .filter((o) => ehOperante(o.status) && leituraDeMidiaDasSettings(o.settings))
      .map((o) => o.id),
  );

  // Motivo permanente / mídia expirada: grava o teto (mesma guarda LGPD) para sair da consulta.
  for (const m of candidatas) {
    if (!elegiveis.has(m.organization_id) || !descartavelParaSempre(m)) continue;
    const { error: erroTeto } = await admin
      .from("messages")
      .update({ metadata: { ...(m.metadata ?? {}), derive_retries: MAX_REPROCESSOS } })
      .eq("id", m.id)
      .eq("organization_id", m.organization_id)
      .eq("media_derived_status", "failed")
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA);
    if (erroTeto) logger.warn("[media-derive-retry] teto não gravado", { message_id: m.id, erro: erroTeto.message, requestId });
  }

  const lote = selecionarParaReprocesso(candidatas, agora.getTime(), elegiveis);
  let reemitidas = 0;
  let falhas = 0;
  for (const m of lote) {
    // Conta ANTES de emitir e só se ainda estiver `failed`: tentativa sem registro
    // viraria laço infinito; a guarda evita contar sobre mensagem que já virou ready.
    const feitos = reprocessosFeitos(m.metadata);
    let upd = admin
      .from("messages")
      .update({
        metadata: {
          ...(m.metadata ?? {}),
          derive_retries: feitos + 1,
          derive_last_retry_at: agora.toISOString(),
        },
      })
      .eq("id", m.id)
      .eq("organization_id", m.organization_id)
      .eq("media_derived_status", "failed")
      // Guarda otimista: outra rodada que contou primeiro faz esta casar 0 linhas (não emite).
      // Redigida pela cascata LGPD também casa 0: não regrava o metadata que ela zerou.
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA);
    upd = feitos > 0 ? upd.eq("metadata->>derive_retries", String(feitos)) : upd.is("metadata->>derive_retries", null);
    const { data: gravada, error: erroUpdate } = await upd.select("id");
    if (erroUpdate) {
      falhas++;
      logger.error("[media-derive-retry] contagem não gravada", { message_id: m.id, erro: erroUpdate.message, requestId });
      continue;
    }
    if (!gravada || gravada.length === 0) continue;
    const { error: erroEmit } = await admin.rpc("emit_event", {
      p_event_type: "media.derive_requested",
      p_entity_kind: "message",
      p_entity_id: m.id,
      p_payload: { message_id: m.id },
      p_metadata: { source: "retry_automatico", request_id: requestId },
      p_organization_id: m.organization_id,
    });
    if (erroEmit) {
      falhas++;
      logger.error("[media-derive-retry] evento não emitido", { message_id: m.id, erro: erroEmit.message, requestId });
      continue;
    }
    reemitidas++;
  }
  return { examinadas: candidatas.length, reemitidas, falhas };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  let resultado: ReprocessoResultado;
  try {
    resultado = await reprocessarMidiasFalhas(createAdminClient(), requestId);
  } catch (err) {
    logger.error("[media-derive-retry] varredura falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Failed to scan messages.", 500, { requestId });
  }
  if (resultado.reemitidas > 0 || resultado.falhas > 0) {
    void audit({
      action: "media.derive_auto_retry_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...resultado },
      requestId,
    });
  }
  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
