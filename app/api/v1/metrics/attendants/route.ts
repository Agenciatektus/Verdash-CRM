/**
 * GET /api/v1/metrics/attendants — métricas por responsável (spec 13 §6).
 *
 * Escopo = a PRÓPRIA RLS: a agregação (`fn_attendant_metrics`, SECURITY INVOKER)
 * roda com o client user-scoped (cookie session), então crm_leads (0036) e
 * conversations (0035) já filtram por atendente. agent ⇒ vê só as próprias
 * (own-scope G1-06a; a lista "por atendente" colapsa a 1 linha, a dele);
 * manager+ ⇒ org-wide + filtro opcional `owner_user_id`. Piso de rota = agent.
 * org da org ativa (cookie validado), NUNCA do body/query. Read-only ⇒ sem audit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { nomesDeMembros } from "@/lib/users/nomes-de-membros";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().optional(),
});

interface AttendantRow {
  user_id: string;
  won: number;
  lost: number;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
}

interface MetricsPayload {
  funnel: { stage_id: string; stage_name: string; position: number; count: number }[];
  attendants: AttendantRow[];
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // spec 13 §6.1: piso agent (vê as próprias); RLS gate a comparação manager+.
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_attendant_metrics", {
    p_org: activeOrg.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_owner: parsed.data.owner_user_id,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const metrics = (data ?? { funnel: [], attendants: [] }) as unknown as MetricsPayload;

  // Enriquece cada atendente com nome/email (mesmo padrão de /api/v1/team).
  // Degrada com name=null quando o service role não está configurado (dev).
  const membros = await nomesDeMembros(activeOrg.orgId, metrics.attendants.map((a) => a.user_id));
  const names = new Map(
    [...membros].map(([id, m]) => [id, { name: m.full_name, email: m.email }] as const),
  );

  const attendants = metrics.attendants.map((a) => ({
    ...a,
    name: names.get(a.user_id)?.name ?? null,
    email: names.get(a.user_id)?.email ?? null,
  }));

  return ok(
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      owner_user_id: parsed.data.owner_user_id ?? null,
      funnel: metrics.funnel,
      attendants,
    },
    { requestId },
  );
}
