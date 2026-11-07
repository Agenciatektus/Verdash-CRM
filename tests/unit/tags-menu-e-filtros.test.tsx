/**
 * Onda 2, Etiquetas: o menu ⋯ da linha chama a ação certa, o filtro "Fora do
 * vocabulário" esconde as curadas e a barra de lote só existe com seleção.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";
import { escolherNaLinha } from "./helpers/menu-da-linha-de-tags";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { MenuDaLinha } from "@/app/app/settings/tags/_menu-da-linha";
import { PainelDeTags } from "@/app/app/settings/tags/_painel";

const base: LinhaDeVocabulario = {
  tag: "vip",
  uso_em_contatos: 1,
  uso_em_leads: 0,
  uso_em_conversas: 0,
  em_regras: 0,
  cor: null,
  descricao: null,
  no_vocabulario: true,
};
const FORA = { ...base, tag: "ddd-11", no_vocabulario: false };

function montar() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PainelDeTags tags={[base, FORA]} idioma="pt-BR" />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("menu ⋯ da linha", () => {
  it.each(["Cor", "Renomear", "Juntar", "Excluir"])("%s chama a ação dela", async (item) => {
    const aoEscolher = vi.fn();
    render(<MenuDaLinha tag="vip" reservada={false} t={(x) => x} aoEscolher={aoEscolher} />);
    await userEvent.click(screen.getByRole("button", { name: /Ações da etiqueta vip/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: item }));
    expect(aoEscolher).toHaveBeenCalledWith(
      { Cor: "definir_cor", Renomear: "renomear", Juntar: "juntar", Excluir: "excluir" }[item],
    );
  });

  it("a etiqueta reservada só oferece Cor", async () => {
    render(<MenuDaLinha tag="cliente" reservada t={(x) => x} aoEscolher={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Ações da etiqueta/ }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
  });

  it("na tela, Renomear abre o diálogo da etiqueta da linha", async () => {
    montar();
    await escolherNaLinha(0, "Renomear");
    expect(await screen.findByRole("dialog")).toHaveTextContent("Renomear vip para:");
  });
});

describe("filtros e lote", () => {
  it("'Fora do vocabulário' esconde as etiquetas curadas", () => {
    montar();
    expect(screen.getByText("vip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fora do vocabulário" }));
    expect(screen.queryByText("vip")).not.toBeInTheDocument();
    expect(screen.getByText("ddd-11")).toBeInTheDocument();
  });

  it("a barra de lote só aparece com seleção", () => {
    montar();
    expect(document.querySelector("[data-lote-de-etiquetas]")).toBeNull();
    fireEvent.click(screen.getByLabelText("Selecionar vip"));
    expect(document.querySelector("[data-lote-de-etiquetas]")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Selecionar vip"));
    expect(document.querySelector("[data-lote-de-etiquetas]")).toBeNull();
  });

  it("trocar de filtro limpa a seleção: a barra não age em etiqueta escondida", () => {
    montar();
    fireEvent.click(screen.getByLabelText("Selecionar vip"));
    expect(document.querySelector("[data-lote-de-etiquetas]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fora do vocabulário" }));
    expect(document.querySelector("[data-lote-de-etiquetas]")).toBeNull();
    fireEvent.click(screen.getByLabelText("Selecionar todas as etiquetas"));
    expect(document.querySelector("[data-lote-de-etiquetas]")).toHaveAttribute("data-lote-de-etiquetas", "1");
  });
});
