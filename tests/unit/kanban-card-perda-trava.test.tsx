import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { Lead } from "@/lib/types/leads";

/**
 * P2-1 do Cassio na #182: no quadro (desktop), a PERDA e a TROCA DE FUNIL do card
 * gravavam na hora e ignoravam a trava por negócio. Agora passam por
 * `adiarFechamento` (5 s com Desfazer) como o ganho: com o ganho do negócio
 * pendente, a perda e a troca pelo card são recusadas.
 *
 * A trava e o aviso são os REAIS (`fechar-negocio` + `aviso-com-desfazer`); só o
 * `sonner` e as janelas são dublês. A janela dublê chama o `adiar` que o card passa,
 * como a de verdade faz ao confirmar.
 */

const avisos = vi.hoisted(() => [] as { opcoes: Record<string, unknown> }[]);
const alerta = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign((_m: unknown, opcoes: Record<string, unknown>) => avisos.push({ opcoes }), {
    error: vi.fn(),
    success: vi.fn(),
    warning: alerta,
  }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), get: vi.fn(async () => ({ data: [] })), patch: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
const ganhar = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), mutateAsync: ganhar, isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const perder = vi.hoisted(() => vi.fn(async () => undefined));
const trocar = vi.hoisted(() => vi.fn(async () => undefined));
type PropsDaJanela = { open: boolean; adiar?: (gravar: () => Promise<unknown>) => void };
vi.mock("@/components/kanban/LoseLeadDialog", () => ({
  LoseLeadDialog: ({ open, adiar }: PropsDaJanela) =>
    open ? (
      <button type="button" onClick={() => (adiar ? adiar(perder) : void perder())}>
        confirmar perda
      </button>
    ) : null,
}));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: ({ open, adiar }: PropsDaJanela) =>
    open ? (
      <button type="button" onClick={() => (adiar ? adiar(trocar) : void trocar())}>
        confirmar troca
      </button>
    ) : null,
}));

const LEAD = { id: "l-9", title: "ACME", owner_user_id: null, owner_agent_id: null } as unknown as Lead;

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KanbanCardActions lead={LEAD} pipelineId="p-1" />
    </QueryClientProvider>,
  );
}

async function escolher(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

afterEach(() => {
  // Desfazer solta a trava: um caso não vaza o fechamento pendente para o outro.
  for (const a of avisos.splice(0)) (a.opcoes.action as { onClick: () => void }).onClick();
  perder.mockClear();
  trocar.mockClear();
  ganhar.mockClear();
  alerta.mockClear();
});

describe("card do quadro — perda e troca passam pela trava", () => {
  it("perda pelo card é ADIADA com Desfazer (não grava na hora)", async () => {
    const user = userEvent.setup();
    renderCard();
    await escolher(user, "Marcar como perdido");
    await user.click(screen.getByRole("button", { name: "confirmar perda" }));
    expect(perder).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(1);
  });

  it("⭐ com o ganho pendente, a perda pelo card é recusada", async () => {
    const user = userEvent.setup();
    renderCard();
    await escolher(user, "Marcar como ganho");
    expect(avisos).toHaveLength(1);
    await escolher(user, "Marcar como perdido");
    await user.click(screen.getByRole("button", { name: "confirmar perda" }));
    expect(avisos).toHaveLength(1);
    expect(perder).not.toHaveBeenCalled();
    expect(alerta).toHaveBeenCalledWith("Já há um fechamento em andamento para este negócio");
  });

  it("com o ganho pendente, a troca de funil pelo card é recusada", async () => {
    const user = userEvent.setup();
    renderCard();
    await escolher(user, "Marcar como ganho");
    await escolher(user, "Levar para outro funil");
    await user.click(screen.getByRole("button", { name: "confirmar troca" }));
    expect(avisos).toHaveLength(1);
    expect(trocar).not.toHaveBeenCalled();
  });
});
