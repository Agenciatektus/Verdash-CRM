/**
 * Trava diária da chave da PLATAFORMA e alerta de gasto/saldo (incidente 04/11/2026).
 * Sem banco e sem IA: pool e fetch são dublês. O caso que não se negocia: turno de cliente
 * NUNCA cai pelo corte da plataforma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cortaNaoEssencial,
  limitesDaPlataforma,
  limparMemoDoGastoDaPlataforma,
  naoEssencialPodeSair,
} from "@/lib/ai/plataforma/gasto-da-plataforma";
import { niveisCruzados, rodadaDoAlertaDaPlataforma } from "@/lib/ai/plataforma/alerta-de-saldo";
import { aplicarOrcamento, LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";

type Pool = Parameters<typeof naoEssencialPodeSair>[0];

/** Pool que devolve `cents` para a soma do dia e registra quem perguntou. */
function poolDoGasto(cents: number) {
  const query = vi.fn(async (sql: string) =>
    sql.includes("llm_calls") ? { rows: [{ cents }], rowCount: 1 } : { rows: [], rowCount: 0 },
  );
  return { pool: { query } as unknown as Pool, query };
}

beforeEach(() => {
  limparMemoDoGastoDaPlataforma();
  delete process.env.AI_PLATAFORMA_CORTE_USD_DIA;
});

describe("corte diário da chave da plataforma", () => {
  it("padrões: alerta 0,50 e 1,00, corte 1,00, 3 dias de saldo; aceita vírgula", () => {
    expect(limitesDaPlataforma({})).toEqual({ alertasCents: [50, 100], corteCents: 100, diasDeSaldo: 3 });
    expect(limitesDaPlataforma({ AI_PLATAFORMA_ALERTA_USD_DIA: "2|0,75", AI_PLATAFORMA_CORTE_USD_DIA: "lixo" }))
      .toEqual({ alertasCents: [75, 200], corteCents: 100, diasDeSaldo: 3 });
  });

  it("preview na chave da plataforma acima do corte cai; abaixo, segue", () => {
    expect(cortaNaoEssencial({ purpose: "agent_preview", chaveDaPlataforma: true, gastoHojeCents: 100, corteCents: 100 })).toBe(true);
    expect(cortaNaoEssencial({ purpose: "agent_preview", chaveDaPlataforma: true, gastoHojeCents: 99, corteCents: 100 })).toBe(false);
  });

  it("turno de cliente NUNCA cai, nem com a chave muito acima do corte", () => {
    for (const purpose of ["agent_turn", "checkpoint", "stage_classifier", "transcricao_de_audio", "sentiment_classify"]) {
      expect(cortaNaoEssencial({ purpose, chaveDaPlataforma: true, gastoHojeCents: 10_000, corteCents: 100 })).toBe(false);
    }
  });

  it("chave própria da org não é afetada pelo corte da plataforma", () => {
    expect(cortaNaoEssencial({ purpose: "agent_preview", chaveDaPlataforma: false, gastoHojeCents: 10_000, corteCents: 100 })).toBe(false);
  });

  it("naoEssencialPodeSair nem consulta o banco para turno de cliente", async () => {
    const { pool, query } = poolDoGasto(10_000);
    expect(await naoEssencialPodeSair(pool, "agent_turn", true)).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(await naoEssencialPodeSair(pool, "agent_preview", true)).toBe(false);
  });

  it("leitura que falha segue (o teto mensal da org continua valendo)", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("db fora")) } as unknown as Pool;
    expect(await naoEssencialPodeSair(pool, "agent_preview", true)).toBe(true);
  });

  it("o gate do motor recusa o preview pela chave da plataforma ANTES de sair byte", async () => {
    const { pool } = poolDoGasto(500);
    const gate = (purpose: string) =>
      aplicarOrcamento({
        db: pool,
        organizationId: "00000000-0000-4000-8000-000000000001",
        orcamentoDaConfig: { modo: "off" },
        orcamentoIndisponivelPorque: "dublê",
        chave: "on",
        origemDaChave: "chave_da_instalacao",
        purpose,
        provider: "openrouter",
        model: "anthropic/claude-haiku-5.5",
      } as unknown as Parameters<typeof aplicarOrcamento>[0]);
    await expect(gate("agent_preview")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(gate("agent_turn")).resolves.toBeUndefined();
  });

  it("agent_preview COM lead (rascunho assistido em conversa real) não cai no corte", async () => {
    const { pool } = poolDoGasto(500);
    await expect(
      aplicarOrcamento({
        db: pool,
        organizationId: "00000000-0000-4000-8000-000000000001",
        orcamentoDaConfig: { modo: "off" },
        orcamentoIndisponivelPorque: "dublê",
        chave: "on",
        origemDaChave: "chave_da_instalacao",
        purpose: "agent_preview",
        provider: "openrouter",
        model: "anthropic/claude-haiku-5.5",
        input: { leadId: "lead-1" },
      } as unknown as Parameters<typeof aplicarOrcamento>[0]),
    ).resolves.toBeUndefined();
  });
});

describe("alerta de gasto e saldo da plataforma", () => {
  const base = { alertasCents: [50, 100], corteCents: 100, saldoCents: null, mediaDiariaCents: 0, diasDeSaldo: 3 };

  it("níveis escalonados pelo gasto do dia", () => {
    expect(niveisCruzados({ ...base, gastoHojeCents: 40 }).map((n) => n.id)).toEqual([]);
    expect(niveisCruzados({ ...base, gastoHojeCents: 60 }).map((n) => n.id)).toEqual(["gasto_50"]);
    expect(niveisCruzados({ ...base, gastoHojeCents: 120 }).map((n) => n.id)).toEqual(["gasto_50", "gasto_100", "corte_100"]);
  });

  it("saldo abaixo de N dias do consumo médio alerta", () => {
    expect(niveisCruzados({ ...base, gastoHojeCents: 0, saldoCents: 100, mediaDiariaCents: 50 }).map((n) => n.id)).toEqual(["saldo_dias"]);
    expect(niveisCruzados({ ...base, gastoHojeCents: 0, saldoCents: 1000, mediaDiariaCents: 50 })).toEqual([]);
  });

  it("um envio por nível por dia: o claim repetido não reenvia", async () => {
    const claims = new Set<string>();
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("ia_plataforma_alertas")) {
        const k = String(params?.join("|"));
        if (claims.has(k)) return { rows: [], rowCount: 0 };
        claims.add(k);
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [{ cents: sql.includes("interval '7 days'") ? 50 : 60 }], rowCount: 1 };
    });
    const enviar = vi.fn(async (_orgId: string, _texto: string) => "enviado" as const);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 9 } }))) as unknown as typeof fetch;
    const deps = { db: { query } as unknown as Pool, enviar, orgDoAviso: "org-tektus", apiKey: "k", agora: new Date("2026-11-04T15:00:00Z"), fetchFn, env: {} };

    const r1 = await rodadaDoAlertaDaPlataforma(deps);
    expect(r1.niveis).toEqual(["gasto_50", "saldo_dias"]);
    expect(r1.enviados).toBe(2);
    const r2 = await rodadaDoAlertaDaPlataforma(deps);
    expect(r2.enviados).toBe(0);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[0]?.[0]).toBe("org-tektus");
  });

  it("sem org do aviso configurada, só mede e não envia", async () => {
    const enviar = vi.fn();
    const query = vi.fn(async () => ({ rows: [{ cents: 500 }], rowCount: 1 }));
    const r = await rodadaDoAlertaDaPlataforma({ db: { query } as unknown as Pool, enviar, orgDoAviso: "", apiKey: "", agora: new Date(), env: {} });
    expect(r.niveis.length).toBeGreaterThan(0);
    expect(enviar).not.toHaveBeenCalled();
  });
});
