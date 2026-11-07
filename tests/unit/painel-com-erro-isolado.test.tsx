// Um painel que falha mostra o erro DENTRO dele, com "Tentar de novo" que refaz a
// leitura; antes era uma frase vermelha solta e sem saída.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const refetch = vi.fn();
vi.mock("@/hooks/metrics/usePrevisaoFunil", () => ({
  usePrevisaoFunil: () => ({ data: undefined, isLoading: false, isError: true, isFetching: false, refetch }),
}));

import { PrevisaoPanel } from "@/app/app/metrics/_components/PrevisaoPanel";

describe("erro isolado por painel", () => {
  it("Previsão com erro: aviso crítico no painel e 'Tentar de novo' refaz a consulta", async () => {
    render(<PrevisaoPanel />);

    expect(screen.getByRole("alert")).toHaveTextContent("Erro ao carregar a previsão.");
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
