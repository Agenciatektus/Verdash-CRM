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

const chamadas: Array<Record<string, unknown>> = [];
let vazioComProxima = false;

vi.mock("@/hooks/useLgpdRequests", () => ({
  useLgpdRequests: (f: Record<string, unknown>) => {
    chamadas.push(f);
    return {
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      data: vazioComProxima
        ? { data: [], meta: { total: 30, page: 1, limit: 25, has_more: true } }
        : {
            data: [linha("aaaa0001-0", -2, "overdue"), linha("bbbb0002-0", 12, "ok")],
            meta: { total: 2, page: 1, limit: 25, has_more: false },
          },
    };
  },
}));

import { RequestsTable } from "./RequestsTable";

describe("RequestsTable: coluna Prazo e filtro de urgentes", () => {
  it("prazo vencido mostra 'N dias em atraso' com tom crítico", () => {
    render(<RequestsTable />);
    const texto = screen.getByText(/dias em atraso/);
    expect(texto.closest("[data-tom]")).toHaveAttribute("data-tom", "crit");
    expect(screen.getByText(/^12 dias$/).closest("[data-tom]")).toHaveAttribute("data-tom", "ok");
  });

  it("'Ver só as urgentes' liga o chip e pede o filtro ao servidor (sem filtrar a página no cliente)", () => {
    render(<RequestsTable />);
    fireEvent.click(screen.getByRole("button", { name: "Ver só as urgentes" }));
    expect(screen.getByRole("button", { name: "Urgentes" })).toHaveAttribute("aria-pressed", "true");
    expect(chamadas.some((c) => c.sla_bucket === "urgent" && c.limit === 25)).toBe(true);
    // a lista é a que o servidor devolveu: nada some no cliente
    expect(screen.getByText("cliente-bbbb")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver só as urgentes" })).not.toBeInTheDocument();
  });

  it("página vazia com filtro ligado e próxima página não diz 'Nenhuma solicitação LGPD'", () => {
    vazioComProxima = true;
    render(<RequestsTable />);
    fireEvent.click(screen.getByRole("button", { name: "Urgentes" }));
    expect(screen.queryByText("Nenhuma solicitação LGPD")).not.toBeInTheDocument();
    expect(screen.getByText("Nenhuma solicitação neste filtro")).toBeInTheDocument();
    expect(screen.getByText("Há mais resultados na próxima página.")).toBeInTheDocument();
    vazioComProxima = false;
  });
});
