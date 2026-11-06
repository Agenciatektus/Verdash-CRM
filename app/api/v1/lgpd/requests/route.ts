/**
 * GET /api/v1/lgpd/requests
 *
 * Lista paginada de lgpd_requests para o tenant ativo.
 * Apenas role >= admin pode acessar (lgpd:execute permission).
 * organization_id sempre resolvido de sessão confiável — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { computeSlaBucket, corteDosUrgentes } from "@/lib/lgpd/balde-de-sla";

export const dynamic = "force-dynamic";

// shortcut: baldes por razão de prazo classificam em memória até este teto; acima
// disso, mover `computeSlaBucket` para uma coluna gerada ou RPC.
const TETO_DO_BALDE = 2000;

const querySchema = z.object({
  status: z
    .enum(["received", "processing", "completed", "failed", "pending_review"])
    .optional(),
  type: z
    .enum(["redact", "data_request", "store_redact"])
    .optional(),
  // "urgent" = em aberto com prazo vencido ou a menos de 2 dias; filtrado no BANCO, antes da página.
  sla_bucket: z.enum(["overdue", "critical", "warning", "ok", "urgent"]).optional(),
  only_count: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * O BALDE DE SLA da linha é `computeSlaBucket`, de `lib/lgpd/balde-de-sla.ts` —
 * função pura, testada em `tests/unit/lgpd-prazo-e-dia-civil.test.ts`. O motivo
 * de a régua não estar neste arquivo está no cabeçalho de lá.
 */

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: "leitura",
    permiteOrgSuspensa: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  // Parse + validate query params
  const rawParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { status, type, page, limit } = parsed.data;

  const orgId = activeOrg.orgId;
  const offset = (page - 1) * limit;

  // "urgent" é corte de data e vai ao BANCO. Os outros baldes dependem da razão
  // recebido→prazo (`computeSlaBucket`), que o PostgREST não expressa: a rota busca
  // a org até TETO_DO_BALDE, classifica e SÓ ENTÃO pagina. Filtrar a página já
  // recortada escondia o pedido em alerta que estivesse na página 2.
  const urgent = parsed.data.sla_bucket === "urgent";
  const balde = parsed.data.sla_bucket && !urgent ? parsed.data.sla_bucket : null;
  const corte = corteDosUrgentes();

  let total = 0;
  if (!balde) {
    let countQuery = supabase
      .from("lgpd_requests")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (status) countQuery = countQuery.eq("status", status);
    if (type) countQuery = countQuery.eq("request_type", type);
    if (urgent) countQuery = countQuery.not("status", "in", "(completed,failed)").lt("due_at", corte);
    const { count } = await countQuery;
    total = count ?? 0;
    if (parsed.data.only_count === "true") {
      return ok([], { requestId, meta: { total, page, limit, has_more: false } });
    }
  }

  // Data query
  let dataQuery = supabase
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message",
    )
    .eq("organization_id", orgId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: false });
  dataQuery = balde ? dataQuery.limit(TETO_DO_BALDE) : dataQuery.range(offset, offset + limit - 1);

  if (status) dataQuery = dataQuery.eq("status", status);
  if (type) dataQuery = dataQuery.eq("request_type", type);
  if (urgent) dataQuery = dataQuery.not("status", "in", "(completed,failed)").lt("due_at", corte);
  // "Em alerta" e "No prazo" vivem do corte em diante (ou sem prazo): filtrar no
  // banco impede que o histórico vencido, primeiro na ordem, ocupe o teto.
  if (balde === "warning" || balde === "ok") dataQuery = dataQuery.or(`due_at.gte.${corte},due_at.is.null`);

  const { data: rows, error: dbErr } = await dataQuery;
  if (dbErr) {
    return fail("internal_error", dbErr.message, 500, { requestId });
  }

  // Balde por linha. A régua mora em `lib/lgpd/balde-de-sla.ts` porque é
  // aritmética de DIA CIVIL (`due_at` guarda um dia, não um instante) e
  // aritmética testada precisa ficar onde o teste alcança. A versão que estava
  // neste arquivo comparava milissegundos e marcava "Vencido" 26h antes do prazo.
  const enriched = (rows ?? []).map((r) => ({
    ...r,
    sla_bucket: computeSlaBucket(r.due_at, r.received_at),
  }));

  if (balde) {
    const doBalde = enriched.filter((r) => r.sla_bucket === balde);
    total = doBalde.length;
    const pagina = parsed.data.only_count === "true" ? [] : doBalde.slice(offset, offset + limit);
    return ok(pagina, { requestId, meta: { total, page, limit, has_more: offset + limit < total } });
  }

  return ok(enriched, {
    requestId,
    meta: {
      total,
      page,
      limit,
      has_more: offset + limit < total,
    },
  });
}
