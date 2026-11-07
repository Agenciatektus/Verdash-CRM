import type { Locator, Page } from "@playwright/test";

/**
 * O seletor de organização VISÍVEL. No desktop ele mora no trilho e é só a
 * sigla/foto; a cópia do topo (`TopBar`) fica no DOM com `md:hidden`, só para o
 * celular. Sem o filtro, `getByTestId` acha as duas e o strict mode reprova.
 */
export function seletorDeOrganizacao(page: Page): Locator {
  return page.getByTestId("tenant-switcher").filter({ visible: true });
}

/**
 * O nome da organização ativa no seletor. No trilho o texto visível é a sigla;
 * o nome inteiro está no nome acessível ("Organização: <nome>. Trocar de
 * organização"), que é o que se mede. Ancorado nos dois lados: "Org" não casa
 * com "Org B".
 */
export function nomeDaOrganizacao(nome: string): RegExp {
  const literal = nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`: ${literal}(\\.|$)`);
}
