import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const linha = (id: string, due: number, bucket: string) => ({
  id,
  organization_id: "o",
  request_type: "redact",
  source: "manual",
  contact_id: null,
  external_customer_id: `cliente-${id.slice(0, 4)}`,
  status: "received",
  attempts: 0,
  received_at: dia(-10),
  due_at: dia(due),
  completed_at: null,
  emergency: false,
  scope: "contact",
  error_message: null,
  sla_bucket: bucket,
});

vi.mock("@/hooks/useLgpdRequests", () => ({
  useLgpdRequests: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      data: [linha("aaaa0001-0", -2, "overdue"), linha("bbbb0002-0", 12, "ok")],
      meta: { total: 2, page: 1, limit: 25, has_more: false },
    },
  }),
}));

import { RequestsTable } from "./RequestsTable";

describe("RequestsTable: coluna Prazo e filtro de urgentes", () => {
  it("prazo vencido mostra 'N dias em atraso' com tom crítico", () => {
    render(<RequestsTable />);
    const texto = screen.getByText(/dias em atraso/);
    expect(texto.closest("[data-tom]")).toHaveAttribute("data-tom", "crit");
    expect(screen.getByText(/^12 dias$/).closest("[data-tom]")).toHaveAttribute("data-tom", "ok");
  });

  it("'Ver só as urgentes' liga o chip e esconde o que não é urgente", () => {
    render(<RequestsTable />);
    expect(screen.getByText("cliente-bbbb")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver só as urgentes" }));
    expect(screen.getByRole("button", { name: "Urgentes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("cliente-bbbb")).not.toBeInTheDocument();
    expect(screen.getByText("cliente-aaaa")).toBeInTheDocument();
    // com o filtro ligado a ação some do aviso
    expect(screen.queryByRole("button", { name: "Ver só as urgentes" })).not.toBeInTheDocument();
  });
});
