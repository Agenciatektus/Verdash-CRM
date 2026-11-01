/**
 * GET /api/v1/tasks/atrasadas — quantas tarefas venceram na mão de quem pede.
 *
 * O número ao lado de "Tarefas" no menu (S14 da auditoria do visual v2). Uma
 * chamada a `fn_tarefas_atrasadas` (migration 9047): `count(*)` pelo índice
 * parcial `crm_tasks_atrasadas_do_responsavel_idx`, por organização e
 * responsável. Nada de listar e contar no navegador.
 *
 * Quem vê tarefas é toda a organização (`viewer`+, a mesma régua da lista); o
 * recorte por responsável é de PERGUNTA, não de permissão: o menu mostra o que
 * a pessoa pode resolver. Cliente da sessão (RLS de `crm_tasks` vale) e a
 * organização passada à mão, que é a regra do CLAUDE.md.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { rpc } from "@/lib/supabase/rpc";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "fn_tarefas_atrasadas", {
    p_organizacao: authz.org.orgId,
  });
  if (error) {
    return fail("internal_error", traduzir("Erro ao contar as tarefas.", authz.user.idioma), 500, { requestId });
  }

  return ok({ atrasadas: typeof data === "number" ? data : 0 }, { requestId });
}
