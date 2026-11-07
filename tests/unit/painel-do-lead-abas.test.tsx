import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * O PAINEL DO LEAD EM ABAS (visual v2, fase 3.3).
 *
 * O que estes casos guardam, e por quê:
 *  1. As quatro abas são um `tablist` de verdade: setas do teclado andam, e a
 *     aba inativa sai da árvore de acessibilidade (`hidden`), não só da vista.
 *  2. A aba escolhida é lembrada POR NAVEGADOR, e um valor estranho no storage
 *     cai no Resumo em vez de deixar o painel sem aba nenhuma.
 *  3. O `crm-summary` sai UMA vez por conversa, por mais que se troque de aba:
 *     buscar por aba multiplicaria a leitura e daria retratos de momentos
 *     diferentes do mesmo contato.
 *  4. Os atalhos do cabeçalho (Próximo passo, Detalhes, Obs) levam à seção
 *     certa do Resumo, de qualquer aba.
 *  5. Modo leitura não oferece gesto que grava, em nenhuma aba.
 */

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const CHAVE = "inbox.painel.aba";

const auth = vi.hoisted(() => ({
  user: { id: "u-1", support: null as null | { access_mode: string } },
  pode: true,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: auth.user }),
  usePermission: () => auth.pode,
}));

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null, isError: false }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

const scroll = vi.fn();
window.HTMLElement.prototype.scrollIntoView = scroll;

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const RESUMO = {
  leads: [
    {
      id: "l-1", title: "Negócio", status: "open", value_cents: null, currency: null,
      updated_at: "2026-10-01T00:00:00Z", pipeline_id: "p-1", stage_id: "s-1", custom_fields: {}, field_defs: [],
      funil_nome: "Vendas", etapa_nome: "Novo", owner_user_id: "u-1", owner_agent_id: null,
    },
  ],
  orders: [],
  activities: [{ id: "a-1", type: "stage_changed", source_module: "crm", performed_at: "2026-10-01T00:00:00Z", payload: null, reason: null, actor_kind: "user" }],
  demandas: [{ id: "d-1", revision: 1, aberta_em: "2026-10-01T00:00:00Z", origem: "inbound", estado: "aberta", proximo_passo: null, proximo_passo_em: null, prazo_em: null }],
  fatos: [],
  historico: [],
};

let tarefas: unknown[] = [];
function responde(url: string) {
  if (url.includes("/crm-summary")) return Promise.resolve({ data: RESUMO });
  if (url.startsWith("/api/v1/tasks")) return Promise.resolve({ data: { tasks: tarefas } });
  if (url.includes("/team/assignable")) return Promise.resolve({ data: [] });
  return Promise.resolve({ data: {} });
}

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

const aba = (nome: string) => screen.getByRole("tab", { name: nome });

beforeEach(() => {
  window.localStorage.clear();
  auth.user = { id: "u-1", support: null };
  auth.pode = true;
  scroll.mockClear();
  tarefas = [];
  get.mockReset();
  get.mockImplementation(responde);
});

describe("painel do lead — abas", () => {
  it("abre no Resumo e troca de aba no clique; a inativa fica hidden", async () => {
    renderPainel();
    await screen.findByTestId("inbox-demandas");

    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Resumo", "Negócios", "Empresa", "Atividade"]);
    expect(aba("Resumo")).toHaveAttribute("aria-selected", "true");

    await userEvent.click(aba("Negócios"));
    expect(aba("Negócios")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("inbox-campos-lead").closest('[role="tabpanel"]')).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("inbox-demandas").closest('[role="tabpanel"]')).toHaveAttribute("hidden");
  });

  it("as setas do teclado andam pelas abas, e dão a volta", async () => {
    renderPainel();
    await screen.findByTestId("inbox-demandas");

    aba("Resumo").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(aba("Negócios")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(aba("Negócios"));

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(aba("Atividade")).toHaveAttribute("aria-selected", "true");
  });

  it("lembra a aba escolhida neste navegador e a reabre na próxima montagem", async () => {
    const primeira = renderPainel();
    await userEvent.click(await screen.findByRole("tab", { name: "Atividade" }));
    expect(window.localStorage.getItem(CHAVE)).toBe("atividade");
    primeira.unmount();

    renderPainel();
    expect(await screen.findByRole("tab", { name: "Atividade" })).toHaveAttribute("aria-selected", "true");
  });

  it("valor desconhecido no storage cai no Resumo", async () => {
    window.localStorage.setItem(CHAVE, "aba-que-nao-existe");
    renderPainel();
    expect(await screen.findByRole("tab", { name: "Resumo" })).toHaveAttribute("aria-selected", "true");
  });

  it("o crm-summary sai uma vez por conversa, mesmo passando por todas as abas", async () => {
    renderPainel();
    await screen.findByTestId("inbox-demandas");
    for (const nome of ["Negócios", "Empresa", "Atividade", "Resumo"]) await userEvent.click(aba(nome));

    const doResumo = get.mock.calls.filter(([url]) => String(url).includes("/crm-summary"));
    expect(doResumo).toHaveLength(1);
    // Guarda de vacuidade: a Atividade mostrou o que veio no MESMO pedido.
    expect(screen.getByTestId("inbox-atividade").textContent).not.toMatch(/sem atividade/i);
  });

  it("os atalhos do cabeçalho voltam ao Resumo e levam o foco até a seção", async () => {
    renderPainel();
    await screen.findByTestId("inbox-demandas");
    await userEvent.click(aba("Atividade"));

    await userEvent.click(screen.getByRole("button", { name: "Próximo passo" }));
    expect(aba("Resumo")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("inbox-proximo-passo")));
    expect(scroll).toHaveBeenCalled();

    await userEvent.click(aba("Negócios"));
    await userEvent.click(screen.getByRole("button", { name: "Detalhes do contato" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("inbox-detalhes-do-contato")));
  });

  it("Obs (9041) leva às observações do contato no Resumo, de qualquer aba", async () => {
    renderPainel();
    await screen.findByTestId("inbox-demandas");
    await userEvent.click(aba("Atividade"));
    const obs = screen.getByRole("button", { name: "Obs" });
    expect(obs).not.toHaveAttribute("aria-disabled");
    await userEvent.click(obs);
    expect(aba("Resumo")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("inbox-observacoes-do-contato")));
    expect(await screen.findByRole("textbox", { name: "Observações" })).toBeInTheDocument();
  });
});

/**
 * MODO LEITURA NO PAINEL INTEIRO (revisão do @Cassio_SecRev, P2): o comentário
 * do `CRMSidePanel` promete que TODA ação lê `leitura`. Os dois casos que a
 * produzem (suporte somente leitura e papel `viewer`, que `usePermission` nega)
 * passam pelas quatro abas, com e sem tarefa aberta.
 */
describe("painel do lead — modo leitura", () => {
  const casos = [
    ["acompanhamento de suporte somente leitura", () => { auth.user = { id: "u-1", support: { access_mode: "support_readonly" } }; }],
    ["papel viewer", () => { auth.pode = false; }],
  ] as const;

  it.each(casos)("%s, sem tarefa: Resumo sem formulário, sem edição de contato, sem gesto na demanda", async (_nome, prepara) => {
    prepara();
    renderPainel();
    await screen.findByTestId("demanda-sem-proximo-passo");

    expect(screen.getByRole("button", { name: "Etiqueta do contato" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Encerrar demanda" })).toBeNull();
    expect(screen.queryByTestId("marcar-proximo-passo")).toBeNull();
    expect(await screen.findByText("Criar e concluir tarefas fica com quem atende.")).toBeTruthy();
    expect(screen.queryByTestId("nova-tarefa-rapida")).toBeNull();
    // Detalhes do contato: os valores aparecem, nenhum lápis de edição.
    const detalhes = screen.getByTestId("inbox-detalhes-do-contato");
    expect(detalhes).toHaveTextContent("Fulana");
    // O único botão da seção é o cabeçalho do acordeão (P6); nenhum de editar.
    expect(within(detalhes).queryByRole("button", { name: /Editar/ })).toBeNull();
    expect(within(detalhes).queryByRole("textbox")).toBeNull();
    // Tags da conversa não oferece editor.
    expect(screen.queryByText("Tags da conversa")).toBeNull();
  });

  it.each(casos)("%s, com tarefa: a tarefa aparece sem concluir nem reagendar", async (_nome, prepara) => {
    prepara();
    tarefas = [{ id: "t-1", title: "Ligar", due_date: new Date(Date.now() + 3_600_000).toISOString(), status: "pending", assigned_to: "u-1" }];
    renderPainel();
    const card = await screen.findByTestId("tarefa-do-proximo-passo");
    expect(card).toHaveTextContent("Ligar");
    expect(within(card).queryByRole("button", { name: "Concluir tarefa" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Reagendar" })).toBeNull();
  });

  it.each(casos)("%s: Negócios sem ação, etapa e responsável só leitura", async (_nome, prepara) => {
    prepara();
    renderPainel();
    await screen.findByTestId("demanda-sem-proximo-passo");
    await userEvent.click(aba("Negócios"));

    expect(screen.getByRole("button", { name: "Novo negócio" })).toBeDisabled();
    const acoes = screen.getByTestId("inbox-acoes-do-negocio");
    expect(within(acoes).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("inbox-responsavel-somente-leitura")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("etapa-somente-leitura")).toBeTruthy();
  });
});
