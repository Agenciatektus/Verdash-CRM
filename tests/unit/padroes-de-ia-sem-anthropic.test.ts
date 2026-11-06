/**
 * TRAVA: nenhum PADRÃO DE CÓDIGO escolhe Anthropic/Claude (06/11/2026).
 *
 * Medido em produção: `sentiment_classify` rodava `anthropic/claude-haiku-4-5`
 * (10x o preço do Flash-Lite) para orgs na assinatura ChatGPT, porque o default
 * do produto era esse id. O dono decidiu: assinatura onde der, senão a chave
 * geral da Tektus pela OpenRouter, com modelo barato. Claude só quando a
 * ORGANIZAÇÃO escolhe (binding, versão do agente, settings.llm).
 *
 * Duas metades:
 *  1. os defaults exportados e o registro de pontos, conferidos pelo VALOR;
 *  2. uma varredura do código de produção: literal de modelo Claude fora da
 *     lista de exceções (catálogo, preço, tipo) reprova. Quem reintroduzir um
 *     default Claude em qualquer arquivo novo cai aqui.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { corpoLegadoParaVersao } from "@/lib/ai/agents/legado-para-versao";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_EMBEDDING_MODEL } from "@/lib/ai/gateway";
import * as par from "@/lib/ai/par-provedor-modelo";
import { PONTOS_DE_IA } from "@/lib/ai/pontos/registro";

const ehAnthropic = (id: unknown) => /anthropic|claude/i.test(String(id ?? ""));

describe("os defaults de código não são Anthropic", () => {
  it.each([
    ["DEFAULT_CLASSIFIER_MODEL", DEFAULT_CLASSIFIER_MODEL],
    ["DEFAULT_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL],
  ])("%s = %s", (_nome, valor) => {
    expect(ehAnthropic(valor)).toBe(false);
  });

  it("o default de classificação é o barato alcançável pela OpenRouter da instalação", () => {
    expect(DEFAULT_CLASSIFIER_MODEL).toBe("google/gemini-2.5-flash-lite");
  });

  it("nenhum ponto do registro fixa um modelo Anthropic", () => {
    const fixos = PONTOS_DE_IA.filter(
      (p) => ehAnthropic(p.fixo?.usa?.provider) || ehAnthropic(p.fixo?.usa?.modelId),
    ).map((p) => p.id);
    expect(fixos).toEqual([]);
  });

  it("o par efetivo do agente não tem degrau de compatibilidade Claude", () => {
    expect(par).not.toHaveProperty("MODELOS_DE_COMPATIBILIDADE");
    expect(par).not.toHaveProperty("PROVEDOR_DE_COMPATIBILIDADE");
  });

  it("agente criado sem modelo e sem provedor na org é RECUSADO, não ganha Claude", async () => {
    const r = await par.resolverParEfetivo({ llmDaOrganizacao: null, lerModeloDoCatalogo: async () => null });
    expect(r.ok).toBe(false);
    expect(ehAnthropic(r.provider) || ehAnthropic(r.model)).toBe(false);
  });

  it("a ponte do legado não inventa Claude para agente sem modelo", () => {
    const v = corpoLegadoParaVersao({ system_prompt: "Prompt longo o bastante.", model: null });
    expect(ehAnthropic(v.provider) || ehAnthropic(v.model)).toBe(false);
  });
});

// ── Varredura ───────────────────────────────────────────────────────────────

const RAIZ = path.resolve(__dirname, "../..");
const PASTAS = ["lib", "workers", "app"];

/**
 * Exceções EXPLÍCITAS: arquivo → literais Claude permitidos ali, e por quê.
 * Literal novo (mesmo num arquivo listado) reprova: a lista é por literal.
 */
const EXCECOES: Record<string, { porque: string; literais: string[] }> = {
  "lib/agent-engine/edge/llm/pricing.ts": {
    porque: "tabela de preço",
    literais: [
      "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5",
      "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4", "claude-haiku-4-5",
      "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
      "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4",
    ],
  },
  "lib/ai/gateway.ts": {
    porque: "tipo ModelId (autocomplete) e roteamento pelo prefixo",
    literais: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-haiku-4-5", "anthropic/"],
  },
  "lib/ai/guardrails-schema.ts": {
    porque: "AGENT_MODELS: opções aceitas no corpo legado, não default",
    literais: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-7"],
  },
  "lib/ai/log-invocation.ts": {
    porque: "detecção de provedor pelo prefixo do id",
    literais: ["anthropic/"],
  },
};

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) return nome === "node_modules" ? [] : arquivos(p);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [p] : [];
  });
}

/** Comentário cita o histórico (`anthropic/claude-haiku-4-5` era o default) e não executa. */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const LITERAL = /(["'`])((?:anthropic\/)?claude-[\w.-]*|anthropic\/[\w.-]*)\1/g;

function literaisClaudeForaDaLista(): string[] {
  const achados: string[] = [];
  for (const pasta of PASTAS) {
    for (const arquivo of arquivos(path.join(RAIZ, pasta))) {
      const rel = path.relative(RAIZ, arquivo).split(path.sep).join("/");
      const permitidos = new Set(EXCECOES[rel]?.literais ?? []);
      for (const m of semComentarios(readFileSync(arquivo, "utf8")).matchAll(LITERAL)) {
        if (!permitidos.has(m[2]!)) achados.push(`${rel}: "${m[2]}"`);
      }
    }
  }
  return achados;
}

describe("nenhum literal de modelo Claude fora das exceções", () => {
  it("varre lib/, workers/ e app/ (sem testes)", () => {
    expect(literaisClaudeForaDaLista()).toEqual([]);
  });
});
