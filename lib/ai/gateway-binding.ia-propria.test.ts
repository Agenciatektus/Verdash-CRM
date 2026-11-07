import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ serve: true, resolve: vi.fn() }));

vi.mock("@/lib/cobranca/ia-propria", () => ({
  CODIGO_IA_PROPRIA_SEM_CREDENCIAL: "ia_propria_sem_credencial",
  instalacaoPodeServirIaComMemo: async () => state.serve,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "in", "is"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
    return { from: () => q, rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_CLASSIFIER_MODEL: "anthropic/claude-haiku-4-5",
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  provedorDaChaveDaInstalacao: () => "",
  resolveLanguageModel: state.resolve,
}));

import { resolverModeloDoPonto } from "./gateway-binding";

beforeEach(() => {
  state.serve = true;
  state.resolve.mockReset();
  state.resolve.mockReturnValue("modelo-do-env");
});

describe("resolverModeloDoPonto com plano de IA própria", () => {
  it("CONTROLE NEGATIVO: sem chave da org + env presente -> recusado, env nunca consultado", async () => {
    state.serve = false;
    const r = await resolverModeloDoPonto("sentiment", "org-1", "anthropic/claude-haiku-4-5" as never);
    expect(r).toBeNull();
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("não-regressão: a instalação serve -> cai no env como hoje", async () => {
    const r = await resolverModeloDoPonto("sentiment", "org-1", "anthropic/claude-haiku-4-5" as never);
    expect(r?.model).toBe("modelo-do-env");
    expect(r?.origem).toBe("padrao");
  });
});
