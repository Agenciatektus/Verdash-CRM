import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button loading", () => {
  it("desabilita, marca aria-busy e não dispara o clique", async () => {
    const aoClicar = vi.fn();
    render(<Button loading onClick={aoClicar}>Salvar</Button>);
    const botao = screen.getByRole("button", { name: "Salvar" });

    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("aria-busy", "true");
    await userEvent.setup().click(botao);
    expect(aoClicar).not.toHaveBeenCalled();
  });

  it("sem loading segue como antes", async () => {
    const aoClicar = vi.fn();
    render(<Button onClick={aoClicar}>Salvar</Button>);
    const botao = screen.getByRole("button", { name: "Salvar" });
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("aria-busy");
    await userEvent.setup().click(botao);
    expect(aoClicar).toHaveBeenCalledOnce();
  });
});
