import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Abre o menu ⋯ da N-ésima linha de Etiquetas e escolhe o item (Cor, Renomear, Juntar, Excluir). */
export async function escolherNaLinha(indice: number, item: string) {
  await userEvent.click(screen.getAllByRole("button", { name: /^(Ações|Acciones) (da|de la) etiqueta/ })[indice]!);
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}
