/**
 * POST /api/v1/webhooks/mercadophone?org=<orgId>
 *
 * Venda do PDV -> `orders` + card. Auth: header `mp-auth-code` == token guardado na integração.
 * Sem org/integração/token certo = o mesmo 401 (não revela qual). Processa síncrono (volume baixo).
 * LGPD: o arquivo em webhook_events_log guarda só tipo, id e nomes de chaves (`arquivoSemPii`), nunca valor de cliente nem o header de auth.
 */
import { createHash } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { arquivoSemPii } from "@/lib/mercadophone/arquivo-webhook";
import { tokenConfere } from "@/lib/mercadophone/token-webhook";
import { gravarVenda } from "@/lib/mercadophone/venda";
import { PedidoInvalidoError } from "@/lib/nuvemshop/pedido-mapper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const negado = () => fail("unauthenticated", "unauthorized", 401);

type Cru = Record<string, unknown>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  if (!UUID.test(orgId)) return negado();

  const rawBody = await req.text();
  const admin = createAdminClient();

  const { data: integ } = await admin
    .from("tenant_integrations")
    .select("webhook_secret_encrypted")
    .eq("organization_id", orgId)
    .eq("provider", "mercadophone")
    .eq("status", "healthy")
    .maybeSingle();
  if (!integ?.webhook_secret_encrypted) return negado();

  const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: integ.webhook_secret_encrypted });
  if (dec.error || !dec.data || !tokenConfere(req.headers.get("mp-auth-code"), dec.data as string)) {
    await audit({
      action: "mercadophone.webhook_invalid_token",
      organizationId: orgId,
      metadata: { reason: dec.error ? "decrypt_failed" : "token" },
    });
    return negado();
  }

  let body: Cru;
  try {
    const j = JSON.parse(rawBody) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error();
    body = j as Cru;
  } catch {
    return fail("invalid_request", "invalid_json", 400);
  }

  // Venda pode vir aninhada em `dados`/`venda` ou solta no corpo; o nome real do envelope é desconhecido.
  const tipo = String(body["tipoEvento"] ?? body["evento"] ?? "desconhecido").slice(0, 64);
  const venda = ([body["dados"], body["venda"], body["data"]].find(
    (v) => v && typeof v === "object" && !Array.isArray(v),
  ) ?? body) as Cru;
  const vendaId = String(venda["id"] ?? "noid").slice(0, 64);
  const arquivado = arquivoSemPii(body, venda, tipo, vendaId);

  const hash = createHash("sha256").update(rawBody).digest("hex").slice(0, 16);
  const externalId = `mercadophone:${tipo}:${vendaId}:${hash}`;

  const { data: existing } = await admin
    .from("webhook_events_log")
    .select("id")
    .eq("provider", "generic")
    .eq("organization_id", orgId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (existing) return ok({ accepted: true, idempotent: true });

  const { data: log, error: insertErr } = await admin
    .from("webhook_events_log")
    .insert({
      organization_id: orgId,
      provider: "generic",
      http_method: "POST",
      headers: {},
      raw_body: JSON.stringify(arquivado),
      payload_parsed: arquivado,
      valid_signature: true,
      event_type: `mercadophone.${tipo}`,
      external_id: externalId,
      status: "received",
      attempts: 0,
    })
    .select("id")
    .single();
  if (insertErr) console.error("[mercadophone.webhook] webhook_events_log insert failed", insertErr.message);

  let status: "processed" | "error" = "processed";
  let detalhe: string | null = null;
  const ehVenda = tipo === "venda_salva";
  const cancelamento = tipo.toLowerCase().includes("cancel");
  if (ehVenda || cancelamento) {
    try {
      // Evento de cancelamento sem `status` na venda: força o status para o mapper.
      const r = await gravarVenda(admin, orgId, cancelamento ? { ...venda, status: "cancelada" } : venda);
      if (r.status === "error") {
        status = "error";
        detalhe = r.detail ?? "erro";
      } else if (r.status === "skipped") detalhe = r.detail ?? null;
    } catch (err) {
      status = "error";
      detalhe = err instanceof PedidoInvalidoError ? err.message : "erro_interno";
    }
  } else {
    detalhe = `ignorado:${tipo}`;
  }

  if (log?.id) {
    await admin
      .from("webhook_events_log")
      .update({ status, error_message: detalhe, processed_at: new Date().toISOString() })
      .eq("id", log.id)
      .eq("organization_id", orgId);
  }
  await audit({
    action: "mercadophone.webhook_received",
    organizationId: orgId,
    resourceType: "mercadophone_webhook",
    resourceId: externalId,
    metadata: { tipo, status },
  });
  // 200 mesmo com erro de dado: reentrega não conserta; o log guarda o motivo.
  return ok({ accepted: true, status });
}
