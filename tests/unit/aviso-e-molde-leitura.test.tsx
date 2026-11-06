import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Pagina } from "@/components/pagina";
import { Aviso } from "@/components/ui/aviso";

describe("Aviso: o tom muda cor, ícone E papel", () => {
  it("crit interrompe o leitor de tela (alert); os outros são status", () => {
    const { rerender } = render(<Aviso tom="crit">falhou</Aviso>);
    expect(screen.getByRole("alert")).toHaveAttribute("data-tom", "crit");
    rerender(<Aviso tom="warn">atenção</Aviso>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveClass("bg-warning-bg");
  });

  it("Dispensar só aparece com onDispensar, e chama quem guarda o estado", () => {
    const { rerender } = render(<Aviso>sem botão</Aviso>);
    expect(screen.queryByRole("button")).toBeNull();
    const dispensar = vi.fn();
    rerender(<Aviso onDispensar={dispensar} rotuloDispensar="Fechar">com botão</Aviso>);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(dispensar).toHaveBeenCalledTimes(1);
  });
});

describe("Pagina largura=leitura", () => {
  it("limita cada filho a 768px; o molde total não limita (controle)", () => {
    const { container, rerender } = render(<Pagina largura="leitura"><p>x</p></Pagina>);
    expect(container.firstElementChild).toHaveClass("*:max-w-3xl");
    rerender(<Pagina><p>x</p></Pagina>);
    expect(container.firstElementChild).not.toHaveClass("*:max-w-3xl");
  });
});
