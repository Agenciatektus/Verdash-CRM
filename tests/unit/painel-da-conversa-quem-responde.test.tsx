import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PAINEL DA CONVERSA — a peça que o Inbox e o dossiê do negócio montam.
 *
 * O que ele decide (e que antes morava solto no `InboxLayout`):
 *   1. quem NÃO pode responder não vê o campo — o viewer descobria a regra
 *      pelo 403 depois de digitar;
 *   2. contato bloqueado e acompanhamento somente leitura desabilitam o campo
 *      pelo MESMO `blockedReason`, nunca por um segundo mecanismo;
 *   3. a janela de 24h fechada vira aviso + campo travado, nas duas telas.
 *
 * O `Composer` e o `ChatThread` são substituídos por marcadores que registram
 * as props: o que se testa aqui é a DECISÃO do painel, não o composer.
 */

const permissao = { responder: true };
const suporte = { readonly: false };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (acao: string) => (acao === "inbox.reply" ? permissao.responder : true),
  useAuth: () => ({
    user: {
      id: "u1",
      support: suporte.readonly ? { access_mode: "support_readonly" } : null,
    },
    activeOrg: { orgId: "o1", role: permissao.responder ? "agent" : "viewer" },
  }),
}));

// Atendimento conjunto (#2848): sem participante, o painel decide só pela permissão.
vi.mock("@/hooks/inbox/useParticipantesDaConversa", () => ({
  useParticipantesDaConversa: () => ({ data: [] }),
}));

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

const composerProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/inbox/Composer", async () => {
  const React = await import("react");
  return {
    Composer: React.forwardRef(function ComposerFalso(props: Record<string, unknown>, _ref) {
      composerProps.push(props);
      return <div data-testid="composer" />;
    }),
  };
});
vi.mock("@/components/inbox/ChatThread", () => ({
  ChatThread: (p: { onResponder?: unknown }) => (
    <div data-testid="thread" data-pode-citar={String(Boolean(p.onResponder))} />
  ),
}));
vi.mock("@/components/inbox/RetentionNotice", () => ({
  RetentionNotice: () => <div data-testid="retencao" />,
}));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({
  JanelaFechadaAviso: ({ motivo }: { motivo: string }) => (
    <div data-testid="janela-fechada">{motivo}</div>
  ),
}));

import { PainelDaConversa } from "@/components/inbox/PainelDaConversa";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

function conversa(extra: Partial<ConversationWithContact> = {}): ConversationWithContact {
  return {
    id: "conv-1",
    contact_id: "ct-1",
    status: "open",
    assigned_to_user_id: null,
    last_inbound_at: new Date().toISOString(),
    contacts: { id: "ct-1", name: "Maria", is_blocked: false, is_anonymized: false },
    channel_sessions: { phone_number: "+5522999990000", display_name: null, provider: "verdash" },
    ...extra,
  } as unknown as ConversationWithContact;
}

beforeEach(() => {
  permissao.responder = true;
  suporte.readonly = false;
  composerProps.length = 0;
});

describe("quem pode responder", () => {
  it("atendente (agent+) recebe o campo de resposta e pode citar mensagem", () => {
    render(<PainelDaConversa conversation={conversa()} />);
    expect(screen.getByTestId("composer")).toBeInTheDocument();
    expect(screen.getByTestId("thread")).toHaveAttribute("data-pode-citar", "true");
    expect(screen.queryByTestId("conversa-somente-leitura")).not.toBeInTheDocument();
  });

  it("viewer acompanha a conversa, mas NÃO vê o campo — nem a ação de citar", () => {
    // O servidor já recusa (POST /api/v1/messages exige agent). A tela deixa de
    // prometer o que vai ser recusado depois de a pessoa digitar.
    permissao.responder = false;
    render(<PainelDaConversa conversation={conversa()} />);
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversa-somente-leitura")).toBeInTheDocument();
    expect(screen.getByTestId("thread")).toHaveAttribute("data-pode-citar", "false");
  });

  // Canal oficial (Cloud API) sem mensagem do cliente = janela fechada. O
  // controle positivo abaixo prova que o cenário FECHA a janela — sem ele, o
  // teste do viewer passaria igual num canal que nunca tem janela.
  const janelaFechada = {
    last_inbound_at: null,
    channel_sessions: { phone_number: "+5522999990000", display_name: null, provider: "meta_cloud" },
  } as unknown as Partial<ConversationWithContact>;

  it("controle: para o atendente, esse cenário mostra o aviso e trava o texto livre", () => {
    render(<PainelDaConversa conversation={conversa(janelaFechada)} />);
    expect(screen.getByTestId("janela-fechada")).toBeInTheDocument();
    expect(composerProps.at(-1)?.janelaFechada).toBeTruthy();
  });

  it("viewer também não recebe o aviso de janela, que oferece enviar um modelo", () => {
    permissao.responder = false;
    render(<PainelDaConversa conversation={conversa(janelaFechada)} />);
    expect(screen.queryByTestId("janela-fechada")).not.toBeInTheDocument();
  });
});

describe("o que trava o campo — um mecanismo só", () => {
  it("contato bloqueado desabilita pelo blockedReason", () => {
    render(
      <PainelDaConversa
        conversation={conversa({
          contacts: { id: "ct-1", name: "Maria", is_blocked: true, is_anonymized: false },
        } as Partial<ConversationWithContact>)}
      />,
    );
    expect(composerProps.at(-1)?.blockedReason).toMatch(/bloqueado/);
  });

  it("acompanhamento de suporte somente leitura chega como viewer: sem campo", () => {
    // `resolveActiveOrg` rebaixa o suporte read-only a `viewer`, então o gate
    // `inbox.reply` é o que o cobre — não um segundo ramo no painel.
    suporte.readonly = true;
    permissao.responder = false;
    render(<PainelDaConversa conversation={conversa()} />);
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversa-somente-leitura")).toBeInTheDocument();
  });

  it("conversa fechada chega ao composer como disabled", () => {
    render(<PainelDaConversa conversation={conversa({ status: "closed" } as Partial<ConversationWithContact>)} />);
    expect(composerProps.at(-1)?.disabled).toBe(true);
  });
});

describe("onde o painel está", () => {
  it("no Inbox mostra o aviso de retenção; no dossiê, não", () => {
    const { unmount } = render(<PainelDaConversa conversation={conversa()} />);
    expect(screen.getByTestId("retencao")).toBeInTheDocument();
    unmount();
    render(<PainelDaConversa conversation={conversa()} onde="dossie" />);
    expect(screen.queryByTestId("retencao")).not.toBeInTheDocument();
  });
});
