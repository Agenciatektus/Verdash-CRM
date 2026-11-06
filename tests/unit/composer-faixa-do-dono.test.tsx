import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A FAIXA DE QUEM ATENDE, acima da caixa do composer (visual v2, fase 3.5).
 *
 * Quem escreve precisa saber, antes de escrever, se está falando por cima da
 * IA ou numa conversa que ninguém pegou. A regra é `comandoDaConversa` (a mesma
 * do cabeçalho); aqui se prende a frase, o gesto e o `claim` que ele dispara.
 * O modo LEITURA não chega a montar o composer: quem prende isso é
 * `painel-da-conversa-quem-responde.test.tsx` (`conversa-somente-leitura`).
 */

const claimMock = vi.fn();
const automatico = vi.hoisted(() => ({ ativo: true as boolean | undefined }));

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: claimMock, isPending: false }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: automatico.ativo }) }));
const sessao = vi.hoisted(() => ({
  valor: { user: { id: "u-1" }, activeOrg: { role: "agent" } } as {
    user: { id: string };
    activeOrg: { role: string };
  } | null,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true, useAuthOpcional: () => sessao.valor, usePaisDaOrgAtiva: () => null }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: { drafts: [] } }), post: vi.fn() },
}));

import { Composer } from "@/components/inbox/Composer";
import { apiClient } from "@/lib/api/client";

function conversa(over: Partial<ConversationWithContact> = {}): ConversationWithContact {
  return { ...conversaDeExemplo.conversation, ...over };
}

function montar(c: ConversationWithContact) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId={c.id} conversa={c} />
    </QueryClientProvider>,
  );
}

describe("Composer: faixa de quem atende (C4-C6)", () => {
  beforeEach(() => {
    claimMock.mockClear();
    automatico.ativo = true;
    sessao.valor = { user: { id: "u-1" }, activeOrg: { role: "agent" } };
  });

  it("a IA atendendo: a faixa SUBSTITUI a caixa, e 'Assumir e responder' assume pelo claim", () => {
    montar(conversa());
    expect(screen.getByTestId("faixa-do-dono")).toHaveAttribute("data-quem", "ia");
    expect(screen.getByText("A IA está atendendo.")).toBeInTheDocument();
    expect(screen.getByText("Ao assumir, o automático para nesta conversa.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Mensagem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assumir e responder" }));
    expect(claimMock).toHaveBeenCalledWith(
      { conversation_id: "conv-1", expected_assignee: null },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("'Sugerir resposta' fica na própria faixa quando a IA atende; com outra pessoa, não (P2 da #154)", () => {
    const { unmount } = montar(conversa());
    expect(screen.getByRole("button", { name: "Sugerir resposta" })).toBeInTheDocument();
    unmount();
    montar(conversa({ assigned_to_user_id: "u-2", assigned_to_user_name: "Bruno", assignee_kind: "user" }));
    expect(screen.queryByRole("button", { name: "Sugerir resposta" })).toBeNull();
  });

  it("não trava ninguém: 'Responder sem assumir' devolve a caixa como era", () => {
    montar(conversa());
    fireEvent.click(screen.getByRole("button", { name: "Responder sem assumir" }));
    expect(screen.getByLabelText("Mensagem")).not.toBeDisabled();
    expect(screen.queryByTestId("faixa-do-dono")).toBeNull();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("ninguém assumiu: convida a assumir e diz há quanto tempo o cliente espera", () => {
    const desde = new Date(Date.now() - 14 * 60_000).toISOString();
    montar(conversa({ bot_silenced_until: "infinity", awaiting_since: desde }));
    expect(screen.getByTestId("faixa-do-dono")).toHaveAttribute("data-quem", "ninguem");
    expect(screen.getByText(/O cliente espera há 14m/)).toBeInTheDocument();
  });

  it("org sem automático e sem dono também é 'ninguém', nunca 'a IA está atendendo'", () => {
    automatico.ativo = false;
    montar(conversa());
    expect(screen.getByTestId("faixa-do-dono")).toHaveAttribute("data-quem", "ninguem");
    expect(screen.queryByText("A IA está atendendo.")).toBeNull();
  });

  it("outra pessoa atende: diz quem, oferece a nota e responder mesmo assim (sem puxar)", () => {
    montar(conversa({ assigned_to_user_id: "u-2", assigned_to_user_name: "Bruno", assignee_kind: "user" }));
    expect(screen.getByTestId("faixa-do-dono")).toHaveAttribute("data-quem", "outro");
    expect(screen.getByText(/Bruno está atendendo\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assumir e responder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Escrever nota" }));
    expect(screen.getByLabelText("Mensagem")).toHaveAttribute("placeholder", expect.stringMatching(/nota interna/));
  });

  it("você atende: nenhuma faixa, a caixa direto", () => {
    montar(conversa({ assigned_to_user_id: "u-1", assigned_to_user_name: "Eu", assignee_kind: "user" }));
    expect(screen.queryByTestId("faixa-do-dono")).toBeNull();
    expect(screen.getByLabelText("Mensagem")).toBeInTheDocument();
  });

  it("em nota interna a faixa sai: assumir não muda nada no que só o time lê", () => {
    montar(conversa());
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(screen.queryByTestId("faixa-do-dono")).toBeNull();
    expect(screen.getByLabelText("Mensagem")).toBeInTheDocument();
  });

  it("o botão não se chama só 'Assumir': as specs do cabeçalho o procuram com nome exato", () => {
    montar(conversa());
    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull();
  });

  it("sem a conversa em mãos o composer não afirma nada sobre o dono", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("faixa-do-dono")).toBeNull();
  });
});

describe("Composer: conversa fechada e contato bloqueado (C7, C8)", () => {
  beforeEach(() => {
    sessao.valor = { user: { id: "u-1" }, activeOrg: { role: "agent" } };
  });

  it("fechada: faixa com Reabrir no lugar da caixa", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" conversa={conversa({ status: "closed" })} fechada />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("faixa-conversa-fechada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reabrir" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Mensagem")).toBeNull();
  });

  it("fechada vista por quem só lê: sem Reabrir (P2 da #154)", () => {
    sessao.valor = { user: { id: "u-1" }, activeOrg: { role: "viewer" } };
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" conversa={conversa({ status: "closed" })} fechada />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("faixa-conversa-fechada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reabrir" })).toBeNull();
  });

  it("bloqueado: Desbloquear só para admin (a rota exige admin)", () => {
    const qc = new QueryClient();
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" blockedReason="Contato bloqueado." contatoBloqueadoId="k-1" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("faixa-contato-bloqueado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desbloquear" })).toBeNull();
    unmount();
    sessao.valor = { user: { id: "u-1" }, activeOrg: { role: "admin" } };
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" blockedReason="Contato bloqueado." contatoBloqueadoId="k-1" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Desbloquear" })).toBeInTheDocument();
  });
});

describe("Composer: a dica de teclado fica à vista", () => {
  it("responder e nota têm a dica própria, ligada ao campo", () => {
    montar(conversa({ assigned_to_user_id: "u-1" }));
    const campo = screen.getByLabelText("Mensagem");
    const dica = document.getElementById(campo.getAttribute("aria-describedby")!);
    expect(dica?.textContent).toBe("Enter envia, Shift+Enter quebra linha");
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    expect(dica?.textContent).toBe("Enter salva a nota, Shift+Enter quebra linha");
  });
});

describe("Composer: a sugestão não pergunta ao servidor no modo Nota", () => {
  it("aberto em Nota interna, nenhum pedido de sugestão; ao voltar para Responder, pergunta", async () => {
    vi.mocked(apiClient.get).mockClear();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" initialMode="note" />
      </QueryClientProvider>,
    );
    const pedidos = () => vi.mocked(apiClient.get).mock.calls.filter(([url]) => String(url).includes("/draft-reply")).length;
    await new Promise((r) => setTimeout(r, 20));
    expect(pedidos()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(pedidos()).toBe(1));
  });
});
