import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/**
 * MUDAR A ETAPA PELO DOSSIÊ: o seletor `EtapaNoDossie` do upstream (#3272).
 *
 * Subida 1.90: o dossiê do fork troca a etapa pelo `SeletorDeEtapa` (que move por
 * `useMoveCard` e já pede o motivo da perda), então o fio `onMudarEtapa` do quadro
 * e os casos que mediam o quadro e o dossiê real por esse fio saíram deste arquivo.
 * Fica o contrato do componente, que continua no repositório.
 */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { EtapaNoDossie } from "@/components/kanban/EtapaNoDossie";

// O Select do Radix usa APIs de ponteiro/rolagem que o jsdom não tem (mesmo apoio de etapa-pela-conversa.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const etapasDoSeletor = [
  { id: "s-novo", name: "Novo Lead" },
  { id: "s-neg", name: "Negociando" },
  { id: "s-perdeu", name: "Perdemos" },
];

function montarSeletor(extra: Partial<Parameters<typeof EtapaNoDossie>[0]> = {}) {
  const onMudar = vi.fn();
  render(<EtapaNoDossie etapaAtual="s-novo" etapas={etapasDoSeletor} podeMover onMudar={onMudar} {...extra} />);
  return onMudar;
}

describe("dossiê — o seletor Etapa do funil", () => {
  it("mostra a etapa atual num seletor com as etapas do funil, na ordem", async () => {
    montarSeletor();
    const user = userEvent.setup();
    const seletor = screen.getByRole("combobox", { name: "Etapa do funil" });
    expect(seletor.textContent).toContain("Novo Lead");
    await user.click(seletor);
    const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(opcoes).toEqual(["Novo Lead", "Negociando", "Perdemos"]);
  });

  it("escolher outra etapa — inclusive a de perda — pede o movimento a quem chama, com o id da etapa", async () => {
    // A perda NÃO é decidida aqui: quem chama pede o motivo antes do move.
    const onMudar = montarSeletor();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Etapa do funil" }));
    await user.click(await screen.findByRole("option", { name: "Perdemos" }));
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(onMudar).toHaveBeenCalledWith("s-perdeu");
  });

  it("escolher a etapa em que já está não move", async () => {
    const onMudar = montarSeletor();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Etapa do funil" }));
    await user.click(await screen.findByRole("option", { name: "Novo Lead" }));
    expect(onMudar).not.toHaveBeenCalled();
  });

  it("sem permissão de mover, fica o texto da etapa — sem seletor que recusaria no clique", () => {
    montarSeletor({ podeMover: false });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Novo Lead")).toBeInTheDocument();
  });

  it("sem a lista de etapas, também fica o texto", () => {
    montarSeletor({ etapas: [] });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
