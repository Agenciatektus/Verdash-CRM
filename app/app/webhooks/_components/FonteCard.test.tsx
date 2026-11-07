import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";
import { FonteCard } from "./FonteCard";

function fonte(ativa: boolean): WebhookSourceRow {
  return { id: "f1", name: "Landing de agosto", is_active: ativa, last_change_actor_kind: null, last_change_at: null } as WebhookSourceRow;
}

function montar(ativa: boolean, aoCopiar = vi.fn()) {
  render(
    <IdiomaProvider locale="pt-BR">
      <FonteCard
        source={fonte(ativa)}
        funil="Vendas"
        etapa="Novo"
        recebimento="nunca recebeu"
        url="https://x.test/api/v1/webhooks/in/abc"
        aoAbrir={vi.fn()}
        aoCopiar={aoCopiar}
      />
    </IdiomaProvider>,
  );
  return aoCopiar;
}

describe("FonteCard", () => {
  it("Ativa vira pílula ok e Pausada vira neutra", () => {
    montar(true);
    expect(screen.getByText("Ativa").getAttribute("data-tom")).toBe("ok");
  });

  it("Pausada vira pílula neutra", () => {
    montar(false);
    expect(screen.getByText("Pausada").getAttribute("data-tom")).toBe("neutro");
  });

  it("mostra o destino e copia o endereço", () => {
    const aoCopiar = montar(true);
    expect(screen.getByText(/Vendas › Novo/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copiar endereço" }));
    expect(aoCopiar).toHaveBeenCalledTimes(1);
  });
});
