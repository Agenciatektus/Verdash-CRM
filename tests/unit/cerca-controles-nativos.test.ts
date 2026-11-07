/**
 * Regra 6 do quadro DS: "nada de controle nativo genérico". Data, hora e
 * seletores seguem o design system: `<Escolha>` (components/ui/escolha) no
 * lugar do `<select>`, e `<CampoDeData>` (components/ui/campo-de-data) no
 * lugar de `<input type="date|time|datetime-local">`.
 *
 * Esta cerca reprova controle nativo NOVO fora de `components/ui/` (onde
 * moram os componentes, que usam o `<select>`/`<input>` escondido para
 * formulário). Teste e fixture não entram: eles montam DOM de propósito.
 *
 * `EXCECOES` lista quem ainda não pôde trocar, com o motivo. Ela só encolhe:
 * arquivo listado que já não tem controle nativo também reprova, para a lista
 * não virar licença esquecida.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const PASTAS = ["app", "components", "hooks", "lib"];

const EXCECOES: Record<string, string> = {
  "app/app/ai/memory/_client.tsx":
    "chegou na subida 1.99 (validade do aprendizado, #3537) com o campo de data nativo; `memoria-validade-grava-ao-sair` mede a digitação do ano no campo nativo. Trocar por CampoDeData junto com aquele teste",
  "app/design/components/Switcher.tsx":
    "laboratório de variantes (/design) com tokens e CSS próprios (app/design/lib/tokens, .ds-pill-select): o Escolha traria o tema do CRM para dentro da comparação que ele existe para isolar",
};

const TIPO_NATIVO = /\btype=(?:"(?:date|time|datetime-local)"|\{\s*["'](?:date|time|datetime-local)["']\s*\})/g;
const MARCA = "__campo_nativo_de_data__";

/**
 * Tira comentários e textos entre aspas (`<select>` citado em texto não é
 * controle). O `type="date"` é atributo JSX e é o que se procura: vira uma
 * marca antes de os textos saírem.
 */
export function semComentariosNemTextos(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(TIPO_NATIVO, MARCA)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

export function controlesNativos(fonte: string): string[] {
  const limpo = semComentariosNemTextos(fonte);
  const achados: string[] = [];
  if (/<select[\s>]/.test(limpo)) achados.push("<select>");
  if (limpo.includes(MARCA)) achados.push('type="date|time|datetime-local"');
  return achados;
}

/**
 * Os atributos de cada `<Escolha ...>` (até o `>` que fecha a abertura, fora
 * de chaves). Lê a fonte sem comentários, para `<Escolha>` citado não contar.
 */
export function aberturasDeEscolha(fonte: string): string[] {
  const limpo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const aberturas: string[] = [];
  const re = /<Escolha(?=[\s>/])/g;
  for (let m = re.exec(limpo); m; m = re.exec(limpo)) {
    let fundo = 0;
    let j = m.index + m[0].length;
    for (; j < limpo.length; j += 1) {
      const c = limpo[j];
      if (c === "{") fundo += 1;
      else if (c === "}") fundo -= 1;
      else if (c === ">" && fundo === 0) break;
    }
    aberturas.push(limpo.slice(m.index, j));
  }
  return aberturas;
}

/**
 * `Escolha` com `name` e sem `value`/`defaultValue` (P2 do Cassio na #170): o
 * `<select>` nativo assim enviava a PRIMEIRA opção; a `Escolha` envia "". É o
 * único caso em que o valor do formulário muda na troca.
 */
export function escolhasSemValor(fonte: string): string[] {
  return aberturasDeEscolha(fonte).filter(
    (a) => /\sname=/.test(a) && !/\s(?:value|defaultValue)=/.test(a) && !/\{\.\.\./.test(a),
  );
}

function arquivosTsx(pasta: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(pasta)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosTsx(caminho));
    else if (/\.tsx$/.test(nome) && !/\.test\.tsx$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

const ARQUIVOS = PASTAS.flatMap((p) => arquivosTsx(join(RAIZ, p)))
  .map((c) => relative(RAIZ, c).split(sep).join("/"))
  .filter((c) => !c.startsWith("components/ui/"));

describe("cerca: controle nativo de data, hora e seletor só em components/ui", () => {
  it("nenhum arquivo fora de components/ui usa <select> ou campo nativo de data/hora", () => {
    const culpados = ARQUIVOS.filter((c) => !(c in EXCECOES))
      .map((c) => ({ c, achados: controlesNativos(readFileSync(join(RAIZ, c), "utf8")) }))
      .filter((x) => x.achados.length > 0)
      .map((x) => `${x.c}: ${x.achados.join(", ")} (use Escolha ou CampoDeData de components/ui)`);
    expect(culpados).toEqual([]);
  });

  it("toda exceção ainda tem controle nativo (a lista só encolhe)", () => {
    const vencidas = Object.keys(EXCECOES).filter(
      (c) => !ARQUIVOS.includes(c) || controlesNativos(readFileSync(join(RAIZ, c), "utf8")).length === 0,
    );
    expect(vencidas).toEqual([]);
  });

  it("varre de verdade: os componentes do DS existem e a varredura acha arquivos", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(100);
    expect(readFileSync(join(RAIZ, "components/ui/escolha.tsx"), "utf8")).toContain("<select");
  });

  it("Escolha com name sempre diz o valor (value ou defaultValue)", () => {
    const culpados = ARQUIVOS.filter((c) => escolhasSemValor(readFileSync(join(RAIZ, c), "utf8")).length > 0);
    expect(culpados).toEqual([]);
  });

  it("CONTROLE NEGATIVO: Escolha com name e sem valor é achada; com valor ou sem name, não", () => {
    expect(escolhasSemValor('<Escolha name="plano">\n<option value="a">A</option>\n</Escolha>')).toHaveLength(1);
    expect(escolhasSemValor('<Escolha\n  name="plano"\n  onValueChange={(v) => f(v > 1)}\n>')).toHaveLength(1);
    expect(escolhasSemValor('<Escolha name="plano" defaultValue="a">')).toEqual([]);
    expect(escolhasSemValor('<Escolha name="plano" value={x} onValueChange={f}>')).toEqual([]);
    expect(escolhasSemValor('<Escolha aria-label="Plano" onValueChange={f}>')).toEqual([]);
    expect(escolhasSemValor('// <Escolha name="x">')).toEqual([]);
  });

  it("CONTROLE NEGATIVO: o detector acha select e campo de data, e ignora citação em texto", () => {
    expect(controlesNativos('<select value={x} onChange={f}>')).toEqual(["<select>"]);
    expect(controlesNativos("<select\n  id=\"a\"\n>")).toEqual(["<select>"]);
    expect(controlesNativos('<Input type="date" value={d} />')).toEqual(['type="date|time|datetime-local"']);
    expect(controlesNativos('<input type={"time"} />')).toEqual(['type="date|time|datetime-local"']);
    expect(controlesNativos('<input type="datetime-local" />')).toEqual(['type="date|time|datetime-local"']);
    expect(controlesNativos('// um <select> antigo\n/* <input type="date"> */')).toEqual([]);
    expect(controlesNativos('t("O <select> nativo saiu")')).toEqual([]);
    expect(controlesNativos('<Escolha value={x} />\n<input type="text" />')).toEqual([]);
  });
});
