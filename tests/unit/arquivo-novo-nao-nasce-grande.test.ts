/**
 * Arquivo de produção NOVO não nasce com mais de 300 linhas (regra do repositório;
 * achado 7 da auditoria de 30/10/2026: 432 arquivos já passavam do teto).
 *
 * Os que já existiam ficam em `arquivos-grandes-herdados.json` e podem crescer: um
 * teto neles travaria toda PR que toca um handler grande. A lista só encolhe:
 * quando um herdado volta para ≤300 linhas (ou some), a cerca pede para tirá-lo
 * dela, e daí em diante ele também não pode passar do teto.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
// Fora de propósito: os .ts da raiz (config do Next/Sentry), `scripts/` e `extensoes/`.
const RAIZES = ["app", "lib", "workers", "hooks", "components"];
const TETO = 300;
const HERDADOS: string[] = JSON.parse(
  readFileSync(join(__dirname, "arquivos-grandes-herdados.json"), "utf8"),
);

// Teste, declaração e tipo gerado pelo `supabase gen types` não contam.
const foraDaRegra = (f: string) =>
  /\.(test|spec)\.tsx?$/.test(f) || f.endsWith(".d.ts") || f === "lib/database.types.ts";

// Igual ao `wc -l`: o \n final não abre linha nova.
function linhas(f: string): number {
  const t = readFileSync(join(RAIZ, f), "utf8");
  return t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
}

function producao(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const f = posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "__tests__") producao(f, out);
    } else if (/\.tsx?$/.test(e.name) && !foraDaRegra(f)) {
      out.push(f);
    }
  }
  return out;
}

describe(`arquivo de produção novo tem no máximo ${TETO} linhas`, () => {
  const herdados = new Set(HERDADOS);
  const arquivos = RAIZES.flatMap((r) => producao(r));

  it("nenhum arquivo fora da lista de herdados passa do teto", () => {
    const novosGrandes = arquivos
      .filter((f) => !herdados.has(f))
      .map((f) => ({ f, n: linhas(f) }))
      .filter(({ n }) => n > TETO)
      .map(({ f, n }) => `${f} (${n})`);
    expect(novosGrandes, "divida o arquivo: a lista de herdados não aceita entrada nova").toEqual([]);
  });

  it("a lista de herdados só encolhe: quem voltou ao teto, ou sumiu, sai dela", () => {
    const sobrando = HERDADOS.filter((f) => !existsSync(join(RAIZ, f)) || linhas(f) <= TETO);
    expect(sobrando, "tire estes de tests/unit/arquivos-grandes-herdados.json").toEqual([]);
  });

  it("a cerca mede alguma coisa (controle: a varredura acha os herdados)", () => {
    expect(arquivos.length).toBeGreaterThan(1000);
    expect(arquivos.filter((f) => herdados.has(f)).length).toBe(HERDADOS.length);
  });
});
