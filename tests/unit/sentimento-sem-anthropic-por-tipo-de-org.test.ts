/**
 * MATRIZ: tipo de organização × modelo que o SENTIMENTO executa (06/11/2026).
 *
 * Medido em produção: orgs na assinatura ChatGPT (Delicatto, Fiorotto, Lior,
 * Fabiana) classificavam o clima com `anthropic/claude-haiku-4-5` pela
 * OPENROUTER_API_KEY da instalação. A instalação real tem SÓ a chave da
 * OpenRouter (Anthropic, OpenAI e gateway vazios), e é esse o ambiente aqui:
 * `resolveLanguageModel` e o SDK são os de verdade, só o banco é dublê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cobranca/ia-propria", async (orig) =>
  (await import("@/tests/helpers/ia-propria-instalacao-serve")).instalacaoServeAOrg(await orig()));

const banco = vi.hoisted(() => ({
  settings: null as unknown,
  credencial: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            tabela === "organizations"
              ? { settings: banco.settings }
              : tabela === "ai_provider_credentials"
                ? banco.credencial
                : null, // sem binding; catálogo vazio
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

const { env } = await import("@/lib/env");
const { DEFAULT_CLASSIFIER_MODEL } = await import("@/lib/ai/gateway");
const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");

const ORG = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
const CHAVES = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
const original = Object.fromEntries(CHAVES.map((k) => [k, env[k]]));

/** Como a instalação de produção: só a OpenRouter tem chave. */
function instalacao(chaves: Partial<Record<(typeof CHAVES)[number], string>>) {
  for (const k of CHAVES) (env as Record<string, unknown>)[k] = chaves[k] ?? "";
}

const sentimento = () =>
  resolverModeloDoPonto("sentiment_classify", ORG, DEFAULT_CLASSIFIER_MODEL, {
    naFaltaUsarOPadraoDaOrganizacao: true,
  });

/** O que saiu de fato: o modelo instanciado pelo SDK, não só o rótulo. */
function executado(r: Awaited<ReturnType<typeof sentimento>>) {
  const m = r?.model as { provider?: string; modelId?: string } | undefined;
  return { sdk: m?.provider ?? "", id: m?.modelId ?? "", rotulo: r?.provider ?? "" };
}

beforeEach(() => {
  banco.settings = null;
  banco.credencial = null;
  instalacao({ OPENROUTER_API_KEY: "sk-or-instalacao" });
});
afterEach(() => {
  for (const k of CHAVES) (env as Record<string, unknown>)[k] = original[k];
});

describe("o sentimento nunca executa Claude por padrão", () => {
  it.each([
    ["assinatura ChatGPT com credencial", { llm: { provider: "openai-assinatura", default_model: "gpt-5.4" } }, CREDENCIAL],
    ["assinatura ChatGPT sem credencial", { llm: { provider: "openai-assinatura" } }, null],
    ["OpenRouter sem credencial", { llm: { provider: "openrouter" } }, null],
    // OpenAI direta SEM chave colada na org não tem o que executar: segue na instalação.
    ["OpenAI direta sem credencial", { llm: { provider: "openai", default_model: "gpt-5.6-terra" } }, null],
    ["sem provedor configurado", null, null],
  ])("%s → Flash-Lite pela OpenRouter da instalação", async (_caso, settings, credencial) => {
    banco.settings = settings;
    banco.credencial = credencial;
    const r = await sentimento();
    expect(r?.origem).toBe("padrao");
    expect(r?.modelId).toBe("google/gemini-2.5-flash-lite");
    const e = executado(r);
    expect(e.id).toBe("google/gemini-2.5-flash-lite");
    expect(e.sdk).not.toMatch(/anthropic/i);
    // O rótulo que vai para llm_calls diz quem atendeu, não o prefixo do id.
    expect(e.rotulo).toBe("openrouter");
  });

  // P1 do Cassio (PR #545): org com chave PRÓPRIA num provedor direto classifica
  // no par e na chave DELA. Mandar o texto do cliente final para a OpenRouter da
  // plataforma tira o operador que a org escolheu e passa o custo para a Tektus.
  it.each([
    ["OpenAI direta com chave própria", "openai", "gpt-5.6-terra"],
    ["Anthropic direta com chave própria", "anthropic", "claude-sonnet-5"],
    ["DeepSeek direto com chave própria", "deepseek", "deepseek-v4-flash"],
  ])("%s → par da PRÓPRIA organização, nunca a chave da plataforma", async (_caso, provider, modelo) => {
    banco.settings = { llm: { provider, default_model: modelo } };
    banco.credencial = CREDENCIAL;
    const r = await sentimento();
    expect(r).not.toBeNull();
    expect(r?.origem).not.toBe("padrao");
    expect(r?.modelId).not.toMatch(/^google\//);
    const e = executado(r);
    expect(e.id).not.toMatch(/gemini/);
    expect(e.rotulo).toBe(provider);
  });

  it("assinatura ChatGPT NÃO entra na regra da chave própria: segue no Flash-Lite da instalação", async () => {
    // Fixa o COMPORTAMENTO medido em produção (Delicatto, Fiorotto, Lior,
    // Fabiana): o worker não executa a assinatura, então o sentimento delas roda
    // no Flash-Lite da instalação. Não prova a lista `provedorDiretoComChavePropria`:
    // listar a assinatura ali não muda este resultado (mutação testada em 06/11).
    banco.settings = { llm: { provider: "openai-assinatura", default_model: "gpt-5.4" } };
    banco.credencial = CREDENCIAL;
    const r = await sentimento();
    expect(r?.origem).toBe("padrao");
    expect(executado(r)).toMatchObject({ id: "google/gemini-2.5-flash-lite", rotulo: "openrouter" });
  });

  it("OpenRouter com credencial própria → Flash-Lite na chave DA organização", async () => {
    banco.settings = { llm: { provider: "openrouter" } };
    banco.credencial = CREDENCIAL;
    const r = await sentimento();
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect(executado(r)).toMatchObject({ id: "google/gemini-2.5-flash-lite", rotulo: "openrouter" });
  });

  it("instalação sem chave nenhuma: skip com motivo no log, nunca Claude", async () => {
    instalacao({});
    banco.settings = { llm: { provider: "openai-assinatura" } };
    const { logger } = await import("@/lib/logger");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await sentimento()).toBeNull();
      const motivos = warn.mock.calls.map(([, campos]) => JSON.stringify(campos ?? {}));
      expect(motivos.some((c) => c.includes("motivo"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
