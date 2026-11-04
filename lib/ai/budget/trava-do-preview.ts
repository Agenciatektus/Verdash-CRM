/**
 * TRAVAS DO PREVIEW DE AGENTE ("Testar agente") — custo é dinheiro, falha fecha.
 *
 * O gate por chamada (`aplicarOrcamento` em run-model-call) já corta o preview
 * quando o teto estoura; o que faltava era barrar ANTES de abrir o run e conter
 * clique repetido: teto mensal, um preview por vez e rajada por hora.
 * Erro de leitura recusa (fail-closed), exceto a etapa (a), que falha ABERTA (o gate por chamada ainda corta).
 */
import { env } from "@/lib/env";
import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type TravaDoPreview =
  | { ok: true }
  | { ok: false; codigo: string; status: number; mensagem: string };

const JANELA_RUNNING_MS = 5 * 60_000;
const JANELA_RAJADA_MS = 60 * 60_000;
const LIMITE_PADRAO = 10;

/** String crua do env → inteiro positivo; vazio, lixo ou <=0 volta ao padrão. Nunca lança. */
export function normalizarLimiteDePreviews(cru: string | undefined): number {
  const n = Number.parseInt((cru ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : LIMITE_PADRAO;
}

/** Quantos previews desta org estão `running` há menos de 5 min; null = leitura falhou. */
async function contarEmVoo(admin: Admin, organizationId: string, agora: Date): Promise<number | null> {
  const { count, error } = await admin
    .from("ai_agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("is_dry_run", true)
    .eq("status", "running")
    .gte("started_at", new Date(agora.getTime() - JANELA_RUNNING_MS).toISOString());
  if (error) {
    logger.error("[ai.preview] não foi possível contar previews em andamento", {
      organization_id: organizationId, error: error.message,
    });
    return null;
  }
  return count ?? 0;
}

export async function travaDoPreview(
  admin: Admin,
  organizationId: string,
  agora: Date,
): Promise<TravaDoPreview> {
  // a) teto mensal. 429: o recurso (orçamento) se esgotou e volta no próximo ciclo
  //    ou com ajuste do operador; 402 sugeriria cobrança de plano, que não é o caso.
  const orcamento = await podeGastarComIa(organizationId, "agent_preview");
  if (!orcamento.pode) {
    return {
      ok: false, codigo: "orcamento_atingido", status: 429,
      mensagem: "O teto de gasto de IA deste mês foi atingido, então o teste não pode rodar. Ajuste o limite em Uso de IA › Orçamento.",
    };
  }

  // b) concorrência
  const emVoo = await contarEmVoo(admin, organizationId, agora);
  if (emVoo === null) {
    return { ok: false, codigo: "preview_indisponivel", status: 503, mensagem: "Não foi possível verificar os testes em andamento. Tente de novo em instantes." };
  }
  if (emVoo >= 1) {
    return { ok: false, codigo: "preview_em_andamento", status: 429, mensagem: "Já existe um teste de agente rodando. Aguarde terminar para iniciar outro." };
  }

  // c) rajada por hora
  const limite = normalizarLimiteDePreviews(env.AI_PREVIEW_MAX_POR_HORA);
  const { count, error } = await admin
    .from("ai_agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("is_dry_run", true)
    .gte("started_at", new Date(agora.getTime() - JANELA_RAJADA_MS).toISOString());
  if (error) {
    logger.error("[ai.preview] não foi possível contar previews da última hora", {
      organization_id: organizationId, error: error.message,
    });
    return { ok: false, codigo: "preview_indisponivel", status: 503, mensagem: "Não foi possível verificar o limite de testes. Tente de novo em instantes." };
  }
  if ((count ?? 0) >= limite) {
    return {
      ok: false, codigo: "limite_de_previews", status: 429,
      mensagem: "Limite de testes de agente por hora atingido. Tente de novo mais tarde.",
    };
  }
  return { ok: true };
}

/**
 * Pós-INSERT: fecha a corrida de duas requisições simultâneas. Se há mais de um
 * `running` recente, o próprio run se aborta (os dois podem abortar; aceitável).
 */
export async function confirmarUnicoEmVoo(
  admin: Admin,
  organizationId: string,
  runId: string,
  agora: Date,
): Promise<boolean> {
  const emVoo = await contarEmVoo(admin, organizationId, agora);
  if (emVoo !== null && emVoo <= 1) return true;
  const { error } = await admin
    .from("ai_agent_runs")
    .update({
      status: "aborted",
      completed_at: new Date().toISOString(),
      error_code: "preview_concorrente",
    })
    .eq("organization_id", organizationId)
    .eq("id", runId);
  if (error) {
    logger.error("[ai.preview] não foi possível abortar o run concorrente", {
      organization_id: organizationId, run_id: runId, error: error.message,
    });
  }
  return false;
}
