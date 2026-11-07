/** Defeito real: a consulta falhando deixava a tela nos esqueletos para sempre. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UsageDashboardClient } from "@/app/app/ai/usage/_client";

const refetch = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/ai/useAiUsage", () => ({
  useAiUsage: () => ({ isLoading: false, isError: true, isFetching: false, data: undefined, refetch }),
}));

describe("Uso de IA com a consulta falhando", () => {
  it("mostra o erro e 'Tentar de novo' refaz a consulta", async () => {
    render(<UsageDashboardClient agents={[]} initial={{}} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Não consegui carregar o uso de IA");
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
