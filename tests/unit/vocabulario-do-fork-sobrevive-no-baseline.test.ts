/**
 * O VOCABULÁRIO QUE O FORK ACRESCENTOU A UM CHECK SOBREVIVE NO BASELINE.
 *
 * ## O defeito, medido
 *
 * A migration 0368 do upstream reescreveu `channel_sessions_provider_check` com a
 * lista DELES, sem `'verdash'` nem `'instagram'`: nossos canais pararam de ser
 * gravados (23514) e a 9006 (`o_upstream_apagou_nossos_canais`) teve de devolvê-los.
 * A 0387 do upstream repete o padrão. No próximo merge, o caminho natural é aceitar
 * o `baseline.sql` DELES junto com a migration deles — e aí os dois artefatos voltam
 * a concordar entre si, sem os nossos valores.
 *
 * ## Por que o gate vizinho não vê
 *
 * `check-do-baseline-nao-diverge-da-cadeia.test.ts` compara cadeia × baseline. Ele
 * só acusa quando os dois lados DISCORDAM. Se o merge traz baseline e migration do
 * mesmo autor, eles concordam, e o gate fica mudo exatamente no caso que custou
 * caro. Falta uma âncora que não venha do upstream: o que as NOSSAS migrations
 * prometeram. Aqui a âncora é a última definição de cada constraint nas migrations
 * de número 9xxx (o prefixo reservado ao fork Tektus), e o baseline precisa conter
 * todo literal dela. Valor a mais no baseline não é defeito: o upstream pode crescer
 * a lista; o que não pode é ela encolher o que é nosso.
 *
 * ## Sem lista fixa
 *
 * Nenhum valor e nenhuma constraint estão escritos neste arquivo como "o que
 * vigiar": tudo sai dos arquivos 9xxx. Lista fixa é a forma do defeito que este
 * gate combate (vigia o caso conhecido e dá álibi aos irmãos). O único nome escrito
 * à mão está no controle de vivacidade, como MEDIÇÃO de algo que tem de existir —
 * se o parser morrer ou o glob de 9xxx deixar de casar, o gate fica vermelho em vez
 * de verde por vacuidade.
 *
 * ## O que este arquivo NÃO mede
 *
 * * CHECK **sem nome** (`status text check (…)`): não há nome para casar os dois
 *   lados sem reinventar o batismo automático do Postgres.
 * * Vocabulário em **corpo de função** (`if p_provider not in (…)`, `case …`): só
 *   o `check (…)` de constraint nomeada entra.
 * * Vocabulário que só o **TypeScript** conhece (union types, zod, mapas de
 *   provider): o banco não promete nada sobre ele.
 * * A **ordem real de aplicação** entre 9xxx e migrations do upstream com
 *   timestamp posterior: aqui se olha só o que a 9xxx mais recente declara, não se
 *   uma migration do upstream aplicada depois a sobrescreve na cadeia. Esse caso
 *   aparece no gate vizinho como `falta` (a cadeia encolheu e o baseline não).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aplicar, type Definicao } from "./helpers/vocabulario-de-check";

const RAIZ = join(process.cwd(), "supabase");

/** `<timestamp>_9NNN_<nome>.sql`: o prefixo de número 9xxx é do fork. */
const NOSSA = /^\d+_9\d{3}_.+\.sql$/;

const nossasMigrations = readdirSync(join(RAIZ, "migrations"))
  .filter((f) => NOSSA.test(f))
  .sort();

/**
 * Última definição de cada constraint segundo SÓ as nossas migrations. Aplicá-las
 * em sequência sobre um estado próprio reusa as regras do parser compartilhado: a
 * última vence, e uma 9xxx que derruba sem reconstruir tira a constraint da
 * vigilância (foi decisão nossa).
 */
const nossas = (() => {
  const acc = new Map<string, Definicao>();
  for (const arquivo of nossasMigrations)
    aplicar(acc, readFileSync(join(RAIZ, "migrations", arquivo), "utf8"), arquivo);
  return acc;
})();

const noBaseline = (() => {
  const acc = new Map<string, Definicao>();
  aplicar(acc, readFileSync(join(RAIZ, "baseline.sql"), "utf8"), "baseline.sql");
  return acc;
})();

const ordenado = (s: Set<string>): string[] => [...s].sort();

describe("vocabulário do fork — o que as migrations 9xxx acrescentaram sobrevive no baseline", () => {
  it("a sonda está viva — encontra as nossas constraints e o caso que já custou caro", () => {
    expect(nossasMigrations.length, "nenhuma migration 9xxx encontrada").toBeGreaterThan(0);
    expect(nossas.size, "nenhum CHECK nomeado nas migrations 9xxx").toBeGreaterThan(0);

    // Medição, não lista de vigia: a 9001/9004/9006 declaram este CHECK com os
    // nossos canais. Se ele sumir daqui, o parser ou o glob parou de enxergar.
    const provider = nossas.get("channel_sessions_provider_check");
    expect(provider, "channel_sessions_provider_check não aparece nas 9xxx").toBeDefined();
    expect(ordenado(provider!.valores)).toEqual(expect.arrayContaining(["instagram", "verdash"]));

    // 9101: o PDV MercadoPhone é provider de tenant_integrations; o baseline não pode perdê-lo.
    const integracoes = nossas.get("tenant_integrations_provider_check");
    expect(integracoes, "tenant_integrations_provider_check não aparece nas 9xxx").toBeDefined();
    expect(ordenado(integracoes!.valores)).toEqual(expect.arrayContaining(["mercadophone"]));
    expect(ordenado(noBaseline.get("tenant_integrations_provider_check")!.valores)).toContain("mercadophone");
  });

  it("toda constraint que uma 9xxx nomeia existe no baseline", () => {
    const ausentes = [...nossas.entries()]
      .filter(([nome]) => !noBaseline.has(nome))
      .map(([nome, d]) => `${nome} (última nossa: ${d.origem})`);

    expect(
      ausentes,
      "Uma migration do fork define a constraint e o baseline.sql não a tem.\n" +
        "Quem instala pelo kit self-host (que aplica SÓ o baseline) fica sem ela.\n" +
        "Se veio de um merge do upstream, o baseline deles sobrescreveu o nosso: devolva\n" +
        "o bloco idempotente (`drop constraint if exists` + `add constraint`) ao apêndice.\n",
    ).toEqual([]);
  });

  it("a definição vencedora no baseline contém todo valor da última definição nossa", () => {
    const encolhidas: string[] = [];
    for (const [nome, nossa] of nossas) {
      const doBaseline = noBaseline.get(nome);
      if (doBaseline === undefined) continue; // presença é o caso acima
      const faltando = ordenado(nossa.valores).filter((v) => !doBaseline.valores.has(v));
      if (faltando.length === 0) continue;
      encolhidas.push(`${nome} (última nossa: ${nossa.origem}) — falta: ${faltando.join(", ")}`);
    }

    expect(
      encolhidas,
      "O baseline perdeu valores que uma migration do fork acrescentou.\n" +
        "É a forma da 0368 do upstream (e da 0387): a lista deles reescreve o CHECK sem os\n" +
        "nossos canais, e cada gravação com esse valor bate 23514. O gate cadeia × baseline\n" +
        "não vê quando baseline e migration vêm juntos do upstream, porque concordam entre si.\n" +
        "Conserto: devolva os valores ao bloco canônico do apêndice (UM bloco por constraint)\n" +
        "e, se a cadeia também encolheu, traga uma migration 9xxx forward-fix com a lista\n" +
        "inteira. Editar migration aplicada é proibido.\n",
    ).toEqual([]);
  });
});
