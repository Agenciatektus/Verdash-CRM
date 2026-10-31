/**
 * O texto do turno com a montagem da chamada de volta no lugar (ADR-0006, S8): F9 saiu
 * do `inbound-turn.ts` para três módulos em `turno/` (`conjunto-de-ferramentas.ts`,
 * `classificadores-auxiliares.ts`, `montagem-da-chamada.ts`). Na S9, F10 a F12 saíram
 * para `chamada-do-modelo.ts`, `correcao-pos-modelo.ts` e `fechamento-do-turno.ts`, e
 * voltam aqui do mesmo jeito (as duas saídas do fechamento viram `return { seguir: false … }`). As cercas que liam F9 no
 * orquestrador leem esta remontagem: cada chamada do orquestrador é trocada pelo CORPO
 * da função do módulo, com a indentação original. Assim a ordem entre o "digitando…",
 * os classificadores e o modelo continua medível, e uma chamada que suma do orquestrador
 * lança aqui: um recorte vazio nunca passa verde.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTE = join(process.cwd(), "lib/agent-engine/agent");
const ler = (f: string) => readFileSync(join(AGENTE, f), "utf8");

/** O corpo da função de fase: do fim da desestruturação de `r` até o `return` final. */
function corpoDaFase(arquivo: string): string {
  const fonte = ler(`turno/${arquivo}`);
  // Uma função só por módulo: código fora da fase não entra na remontagem e escaparia das cercas.
  const funcoes = fonte.match(/^(export )?(async )?function /gm) ?? [];
  if (funcoes.length !== 1) throw new Error(`fonte da montagem: ${arquivo} tem ${funcoes.length} funções, esperava 1`);
  const inicio = fonte.search(/= r;\n\n/);
  const fim = fonte.lastIndexOf("\n\n  return {");
  if (inicio < 0 || fim < inicio) throw new Error(`fonte da montagem: ${arquivo} mudou de forma`);
  return fonte
    .slice(fonte.indexOf("\n\n", inicio) + 2, fim)
    .split("\n")
    .map((l) => (l === "" ? l : `  ${l}`))
    .join("\n");
}

function encaixar(fonte: string, chamada: RegExp, trecho: string): string {
  if (!chamada.test(fonte)) throw new Error(`fonte da montagem: chamada ${chamada} sumiu do inbound-turn.ts`);
  return fonte.replace(chamada, () => trecho);
}

export function fonteDoTurnoMontado(): string {
  let t = ler("inbound-turn.ts");
  t = encaixar(
    t,
    /^ {4}const \{ tools, entregues \} = await montarConjuntoDeFerramentas\([\s\S]*?^ {4}\);$/m,
    corpoDaFase("conjunto-de-ferramentas.ts"),
  );
  t = encaixar(
    t,
    /^ {4}const \{ stageSuggestion, stageHintBlock, jailbreakLevel \} = await classificarOTurno\([\s\S]*?^ {4}\);$/m,
    corpoDaFase("classificadores-auxiliares.ts"),
  );
  t = encaixar(
    t,
    /^ {4}const \{ openingMessages, openingTextOnly \} = await montarAberturaDaChamada\([\s\S]*?^ {4}\);$/m,
    corpoDaFase("montagem-da-chamada.ts"),
  );
  // S9: F10 a F12 (chamada do modelo, correções e fechamento).
  t = encaixar(
    t,
    /^ {4}const \{ turn, saidaTruncada \} = await chamarOModelo\([\s\S]*?^ {4}\);$/m,
    corpoDaFase("chamada-do-modelo.ts"),
  );
  t = encaixar(
    t,
    /^ {4}const \{ mensagensDoTurno \} = await corrigirAposOModelo\([\s\S]*?^ {4}\);$/m,
    corpoDaFase("correcao-pos-modelo.ts"),
  );
  t = encaixar(
    t,
    /^ {4}const fechamento = await fecharOTurnoComCheckpoint\([\s\S]*?^ {4}const \{ content, closing, checkpointAnterior \} = fechamento\.valor;$/m,
    corpoDaFase("fechamento-do-turno.ts"),
  );
  return t;
}
