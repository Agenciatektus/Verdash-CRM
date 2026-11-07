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
const PASTAS = ["lib", "workers", "app", "components"];

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
  "components/ai/AgentEditor.tsx": {
    porque:
      "editor do formato LEGADO (`AGENT_MODELS`, lista só Anthropic): o literal é só o valor exibido quando o " +
      "modelo gravado está fora da lista; não executa chamada. Sair daqui pede migrar o editor para o par " +
      "provedor+modelo da versão (pendência declarada ao dono em 06/11/2026).",
    literais: ["anthropic/claude-sonnet-4-6"],
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
  it("varre lib/, workers/, app/ e components/ (sem testes)", () => {
    expect(literaisClaudeForaDaLista()).toEqual([]);
  });
});

// ── SQL: o seed de organização nova também é "padrão de código" ─────────────
//
// P2 do Cassio (PR #545): a varredura só olhava .ts/.tsx, e o maior padrão Claude
// do produto morava numa migration (a 9096 semeia org nova com
// `openrouter` + `anthropic/claude-haiku-5.5`). Migration NOVA (a partir de 01/11/2026)
// que cite modelo Claude só passa se estiver declarada aqui, com o motivo.

const MIGRATIONS = path.join(RAIZ, "supabase", "migrations");
const MIGRATIONS_DECLARADAS: Record<string, string> = {
  "20261104120000_9096_ia_padrao_barato_e_teto_que_para.sql":
    "HISTÓRICO: seed de org nova em openrouter + anthropic/claude-haiku-5.5. SUPERADO pela 9250 (06/11/2026): " +
    "o seed EFETIVO é medido abaixo (`seedEfetivoDeOrgNova`), não por esta lista.",
  "20261105120000_9098_teto_de_ia_padrao_por_plano.sql":
    "HISTÓRICO: repete o seed da 9096 num backfill já executado. SUPERADO pela 9250 (06/11/2026).",
  "20261106220000_9250_org_nova_sem_anthropic.sql":
    "cita `anthropic/claude-haiku-5.5` SÓ no `where` do backfill, para LOCALIZAR e trocar o seed antigo; " +
    "a função que ela cria não cita Claude (medido por `seedEfetivoDeOrgNova`).",
};

function migrationsNovasComClaude(): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(MIGRATIONS)) {
    if (!nome.endsWith(".sql") || nome < "20261101") continue;
    const sql = readFileSync(path.join(MIGRATIONS, nome), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/--.*$/gm, "");
    if (/claude-[\w.-]+/i.test(sql) && !(nome in MIGRATIONS_DECLARADAS)) achados.push(nome);
  }
  return achados;
}

describe("migration nova não semeia Claude escondido", () => {
  it("toda migration de 11/2026 em diante que cita Claude está declarada", () => {
    expect(migrationsNovasComClaude()).toEqual([]);
  });

  it("a declaração da 9096 ainda corresponde a um arquivo que cita Claude (a lista não apodrece)", () => {
    for (const nome of Object.keys(MIGRATIONS_DECLARADAS)) {
      const sql = readFileSync(path.join(MIGRATIONS, nome), "utf8").replace(/--.*$/gm, "");
      expect(/claude-[\w.-]+/i.test(sql), nome).toBe(true);
    }
  });
});

// ── O SEED EFETIVO de organização nova (o que de fato roda no INSERT) ────────
//
// A lista acima só declara migrations antigas. O que importa é a ÚLTIMA definição de
// `fn_seed_org_llm_defaults`: a da cadeia de migrations (quem aplica a cadeia) e a do
// apêndice do baseline (quem roda install.sh/update.sh). As duas não podem semear Claude.
// 06/11/2026: a org nova nascia com `anthropic/claude-haiku-5.5` (9096) e ninguém via.

// Reconhece TODAS as grafias que o Postgres aceita (P2 do Cassio na #553): com ou sem aspas
// (`"public"."fn_x"` é a do pg_dump), com ou sem `public.`, espaço antes do `()`, qualquer
// marcador de corpo (`$$`, `$fn$`...). Uma definição só entra no seed efetivo se for reconhecida.
const DEFINICAO_DO_SEED =
  /create\s+or\s+replace\s+function\s+(?:"?public"?\s*\.\s*)?"?fn_seed_org_llm_defaults"?\s*\(\s*\)[\s\S]*?\bas\s+(\$\w*\$)[\s\S]*?\1\s*;/gi;
// Toda MENÇÃO a criar a função, reconhecida ou não: se houver mais menções do que definições
// reconhecidas, a regex acima está cega para uma grafia e o teste reprova em vez de passar verde.
const MENCAO_DO_SEED = /create\s+(?:or\s+replace\s+)?function\s+[^(;]{0,60}fn_seed_org_llm_defaults/gi;

const semComentariosSql = (sql: string) => sql.replace(/--.*$/gm, "");

function definicoesDoSeed(sql: string): string[] {
  return [...semComentariosSql(sql).matchAll(DEFINICAO_DO_SEED)].map((m) => m[0]);
}
function mencoesCegas(sql: string): number {
  return [...semComentariosSql(sql).matchAll(MENCAO_DO_SEED)].length - definicoesDoSeed(sql).length;
}

function ultimaDefinicaoDoSeed(sql: string): string | null {
  const todas = definicoesDoSeed(sql);
  return todas.length > 0 ? todas[todas.length - 1]! : null;
}

function seedEfetivoDeOrgNova(): { cadeia: string | null; baseline: string | null; cegas: string[] } {
  const arquivos = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
  let cadeia: string | null = null;
  const cegas: string[] = [];
  for (const nome of arquivos) {
    const sql = readFileSync(path.join(MIGRATIONS, nome), "utf8");
    if (mencoesCegas(sql) > 0) cegas.push(nome);
    const def = ultimaDefinicaoDoSeed(sql);
    if (def !== null) cadeia = def; // ordem do nome = ordem de aplicação; a última vence
  }
  const sqlBaseline = readFileSync(path.join(RAIZ, "supabase", "baseline.sql"), "utf8");
  if (mencoesCegas(sqlBaseline) > 0) cegas.push("supabase/baseline.sql");
  return { cadeia, baseline: ultimaDefinicaoDoSeed(sqlBaseline), cegas };
}

describe("o seed efetivo de organização nova não é Anthropic", () => {
  const { cadeia, baseline, cegas } = seedEfetivoDeOrgNova();

  it("nenhuma definição da função escapa do reconhecimento (a trava não está cega)", () => {
    expect(cegas).toEqual([]);
  });

  it.each([
    ["cadeia de migrations", cadeia],
    ["apêndice do baseline", baseline],
  ])("%s: a última definição existe e semeia o padrão barato, sem Claude", (_onde, def) => {
    expect(def, "a função de seed sumiu: org nova nasceria sem padrão de IA").not.toBeNull();
    expect(def!).not.toMatch(/claude|anthropic/i);
    expect(def!).toContain(DEFAULT_CLASSIFIER_MODEL);
  });
});
