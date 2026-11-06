import type { Locator } from "@playwright/test";

/**
 * O `<select>` escondido de uma `Escolha` (`components/ui/escolha.tsx`). O
 * controle visível é o gatilho do Radix (role combobox), que não tem `value`
 * nem `<option>`; o nativo, irmão logo depois dele, carrega o valor, as opções
 * e repassa `selectOption` — é o contrato documentado no componente. Recebe o
 * gatilho achado pelo rótulo, então o rótulo continua sendo medido.
 */
export function nativoDaEscolha(gatilho: Locator): Locator {
  return gatilho.locator("xpath=following-sibling::select[@data-escolha-nativa][1]");
}

/**
 * O `<input>` escondido de um `CampoDeData` (`components/ui/campo-de-data.tsx`):
 * o visível é um botão que abre o calendário; o valor viaja no nativo
 * (`data-campo-nativo`), que repassa a mudança. Achado pelo `<label>` que
 * começa com o rótulo — dois candidatos reprovam pelo strict mode.
 */
export function nativoDoCampoDeData(dentroDe: Locator, rotulo: string): Locator {
  return dentroDe
    .locator("label")
    .filter({ hasText: new RegExp(`^${rotulo}`) })
    .locator("input[data-campo-nativo]");
}
