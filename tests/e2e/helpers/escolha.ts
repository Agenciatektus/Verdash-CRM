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
