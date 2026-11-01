/**
 * GET /api/v1/leads/abertos-por-funil — quantos leads abertos há em cada funil.
 *
 * O número ao lado de cada funil no nó "Pipeline" do menu (S18 da auditoria do
 * visual v2). Uma chamada a `fn_leads_abertos_por_funil` (migration 9047):
 * `count(*) ... group by pipeline_id` pelo índice que já existia,
 * `idx_crm_leads_org_pipeline_status`.
 *
 * `viewer`+, e não `manager` como `GET /api/v1/pipelines`: o menu é visto por
 * todo papel, e o quadro de cada funil também. Cliente da sessão, então a RLS
 * de `crm_leads` decide o que entra na conta: o `agent` em modo `own` conta só
 * os leads que o quadro mostra a ele, nunca o total da organização.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { rpc } from "@/lib/supabase/rpc";

export const dynamic = "force-dynamic";

interface LinhaDaContagem {
  pipeline_id: string;
  abertos: number;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "fn_leads_abertos_por_funil", {
    p_organizacao: authz.org.orgId,
  });
  if (error) {
    return fail("internal_error", traduzir("Erro ao contar os leads.", authz.user.idioma), 500, { requestId });
  }

  // Um objeto `{ <funil>: n }`: o menu procura pelo id, e funil sem lead aberto
  // simplesmente não aparece (o menu lê ausente como zero e não desenha nada).
  const porFunil: Record<string, number> = {};
  for (const linha of (Array.isArray(data) ? data : []) as LinhaDaContagem[]) {
    if (linha?.pipeline_id) porFunil[linha.pipeline_id] = Number(linha.abertos) || 0;
  }
  return ok({ por_funil: porFunil }, { requestId });
}
