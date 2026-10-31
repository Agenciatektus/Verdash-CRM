/**
 * O estado mutável do turno nasce UMA vez (ADR-0006, D4, fatia S6).
 *
 * `criarEstadoDoTurno` zera `seq`, a trava de duplicata e os contadores de veto.
 * O objeto passa por referência do orquestrador às ferramentas e às fases de
 * depois do modelo. Um segundo `criarEstadoDoTurno()` em qualquer módulo daria a
 * uma parte do turno um estado zerado: a trava de duplicata esqueceria o que já
 * saiu e o lead receberia a mesma mensagem duas vezes.
 *
 * A cerca varre o AST de todos os `.ts` de `lib/` (o texto-fonte erraria com
 * comentário ou string que citasse o nome) e exige exatamente uma chamada, dentro
 * de `executarTurnoDoAgente` em `inbound-turn.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ALVO = "lib/agent-engine/agent/inbound-turn.ts";

type Chamada = { arquivo: string; funcao: string | null };

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") saida.push(...arquivosTs(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      saida.push(p);
    }
  }
  return saida;
}

function funcaoQueContem(no: ts.Node): string | null {
  for (let p: ts.Node | undefined = no.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
  }
  return null;
}

function chamadasDaFabrica(arquivo: string, texto: string): Chamada[] {
  const ast = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true);
  const achadas: Chamada[] = [];
  const visit = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isIdentifier(no.expression) &&
      no.expression.text === "criarEstadoDoTurno"
    ) {
      achadas.push({ arquivo, funcao: funcaoQueContem(no) });
    }
    ts.forEachChild(no, visit);
  };
  visit(ast);
  return achadas;
}

describe("o estado do turno nasce uma vez, no orquestrador", () => {
  it("lib/ tem exatamente UMA chamada a criarEstadoDoTurno, dentro de executarTurnoDoAgente", () => {
    const arquivos = arquivosTs(join(RAIZ, "lib"));
    // Controle: a varredura enxergou o próprio alvo (senão zero chamadas passaria por vácuo).
    expect(arquivos.map((a) => relative(RAIZ, a).replace(/\\/g, "/"))).toContain(ALVO);
    const chamadas = arquivos.flatMap((a) =>
      chamadasDaFabrica(relative(RAIZ, a).replace(/\\/g, "/"), readFileSync(a, "utf8")),
    );
    expect(chamadas).toEqual([{ arquivo: ALVO, funcao: "executarTurnoDoAgente" }]);
  });

  it("controle negativo: o detector conta uma segunda chamada e acusa a função errada", () => {
    const texto = [
      "function executarTurnoDoAgente() { const estado = criarEstadoDoTurno(); }",
      "function outraFase() { const e = criarEstadoDoTurno(); }",
      "// criarEstadoDoTurno() num comentário não conta",
      "const s = 'criarEstadoDoTurno()';",
    ].join("\n");
    expect(chamadasDaFabrica(ALVO, texto)).toEqual([
      { arquivo: ALVO, funcao: "executarTurnoDoAgente" },
      { arquivo: ALVO, funcao: "outraFase" },
    ]);
  });
});
