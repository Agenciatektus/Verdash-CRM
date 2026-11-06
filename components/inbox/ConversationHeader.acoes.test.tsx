import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "./ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * PARIDADE E GUIA DAS AÇÕES DO CABEÇALHO (#3003), NA VERSÃO DO FORK.
 *
 * ─── Por que este arquivo difere do upstream ─────────────────────────────────
 *
 * O upstream mede uma barra única, sem menu "Mais ações". O cabeçalho do fork é
 * o da Inbox v2: as ações do FLUXO de atendimento ficam à vista na barra
 * (Assumir, Devolver à IA, Reabrir, Liberar, Transferir, Lembrar, Fechar) e o
 * que é leitura ou exceção mora no menu "Mais ações" (buscar, pausar o
 * automático, ver contato, marcar/desmarcar pessoal, arquivar). A regra "o
 * fluxo não vai para dentro do menu" também é vigiada em
 * `tests/unit/inbox-header-nao-trava.test.tsx`. Aqui o que se protege é o mesmo
 * do #3003: nenhuma ação SOME (em nenhum estado) e todo botão da barra tem guia.
 *
 * ─── Por que a paridade é por CENÁRIO, e não uma lista só ────────────────────
 *
 * As ações são CONDICIONAIS: "Liberar" só existe para o dono, "Reabrir" só em
 * conversa encerrada, "Arquivar" some na já arquivada. Cada cenário declara o
 * seu conjunto EXATO (barra + menu), e um caso à parte afirma que a UNIÃO dos
 * cenários cobre o inventário inteiro: é isso que pega a ação removida do
 * componente.
 *
 * ─── Dublês ─────────────────────────────────────────────────────────────────
 *
 * `useAuth` e `useAutomaticoAtivo` são mutáveis: o estado do cenário decide o
 * que eles devolvem. `SnoozeButton`, `DialButton` e `VideoCallButton` são
 * componentes PRÓPRIOS; o dublê do `SnoozeButton` preserva só o que a paridade
 * mede: que o cabeçalho continua MONTANDO a ação.
 */

const estado = vi.hoisted(() => ({
  auth: {
    user: { id: "u1", support: null } as Record<string, unknown>,
  },
  automaticoDaOrg: true as boolean | undefined,
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: null, ...estado.auth }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useTransferConversation", () => ({
  useTransferConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useSnoozeConversation", () => ({
  useSnoozeConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: estado.automaticoDaOrg }),
}));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/components/inbox/VideoCallButton", () => ({ VideoCallButton: () => null }));
vi.mock("@/components/inbox/ParticipantesDaConversa", () => ({
  ParticipantesDaConversa: () => null,
}));
vi.mock("@/components/inbox/SnoozeButton", () => ({
  SnoozeButton: () => <button type="button">Lembrar depois</button>,
}));

/** As ações À VISTA na barra (nome acessível). */
const DA_BARRA = [
  "Assumir",
  "Liberar",
  "Devolver à IA",
  "Reabrir",
  "Transferir conversa",
  "Lembrar depois",
  "Fechar conversa",
] as const;

/** As ações do menu "Mais ações". */
const DO_MENU = [
  "Buscar nesta conversa",
  "Pausar o automático",
  "Ver contato",
  "Marcar como pessoal",
  "Desmarcar pessoal",
  "Arquivar",
] as const;

/** O INVENTÁRIO — toda ação que o cabeçalho do fork oferece hoje. */
const INVENTARIO: string[] = [...DA_BARRA, ...DO_MENU];

/** Botões da barra que pertencem a outros componentes: a guia deles não é cobrada aqui. */
const GUIAS_DE_OUTROS_COMPONENTES = ["Lembrar depois"];

const CONTATO = {
  id: "contato-1",
  display_name: "Fulana",
  name: null,
  phone_number: "5511999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  is_anonymized: false,
  force_human: false,
};

interface Cenario {
  nome: string;
  conversa?: Record<string, unknown>;
  contato?: Record<string, unknown>;
  auth?: typeof estado.auth;
  automaticoDaOrg?: boolean | undefined;
  /** O conjunto EXATO de ações (barra + menu) que este cenário oferece. */
  esperadas: string[];
  comBusca?: boolean;
}

const CENARIO_MAIS_COMPLETO: Cenario = {
  nome: "minha, com o automático calado — o estado que devolve as duas voltas",
  conversa: {
    assigned_to_user_id: "u1",
    assignee_kind: "user",
    bot_silenced_until: new Date(Date.now() + 10 * 60_000).toISOString(),
  },
  esperadas: [
    "Assumir",
    "Liberar",
    "Devolver à IA",
    "Transferir conversa",
    "Lembrar depois",
    "Fechar conversa",
    "Ver contato",
    "Marcar como pessoal",
    "Arquivar",
  ],
};

const CENARIOS: Cenario[] = [
  {
    nome: "aberta e sem dono — a fila",
    comBusca: true,
    esperadas: [
      "Assumir",
      "Transferir conversa",
      "Lembrar depois",
      "Fechar conversa",
      "Buscar nesta conversa",
      "Ver contato",
      "Marcar como pessoal",
      "Arquivar",
    ],
  },
  CENARIO_MAIS_COMPLETO,
  {
    nome: "com dono e o automático de pé — pausar é gesto PRÓPRIO aqui",
    conversa: { assigned_to_user_id: "u2", assignee_kind: "user" },
    esperadas: [
      "Assumir",
      "Transferir conversa",
      "Lembrar depois",
      "Fechar conversa",
      "Pausar o automático",
      "Ver contato",
      "Marcar como pessoal",
      "Arquivar",
    ],
  },
  {
    nome: "encerrada — o par Fechar/Reabrir vira Reabrir",
    conversa: { status: "closed" },
    esperadas: ["Assumir", "Reabrir", "Ver contato", "Marcar como pessoal", "Arquivar"],
  },
  {
    nome: "arquivada — arquivar de novo não é gesto que exista",
    conversa: { status: "archived" },
    esperadas: ["Assumir", "Reabrir", "Ver contato", "Marcar como pessoal"],
  },
  {
    nome: "contato marcado como pessoal — o par inverte",
    contato: { is_personal: true },
    esperadas: [
      "Assumir",
      "Transferir conversa",
      "Lembrar depois",
      "Fechar conversa",
      "Ver contato",
      "Desmarcar pessoal",
      "Arquivar",
    ],
  },
];

function montar(cenario: Cenario) {
  estado.auth = cenario.auth ?? {
    user: { id: "u1", support: null, is_platform_admin: true },
  };
  estado.automaticoDaOrg = cenario.automaticoDaOrg ?? true;

  const conversa = {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    status: "open",
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    snooze_until: null,
    service_revision: 3,
    is_group: false,
    tags: [],
    contacts: { ...CONTATO, ...cenario.contato },
    channel_sessions: null,
    ...cenario.conversa,
  } as unknown as ConversationWithContact;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversa} onBuscar={cenario.comBusca ? () => {} : undefined} />
    </QueryClientProvider>,
  );
}

/** A barra de ações — achada pelo testid, nunca por índice. */
function barraDeAcoes(): HTMLElement {
  return screen.getByTestId("acoes-da-conversa");
}

function nomeDe(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

/** O que o cenário oferece: os botões da barra MAIS os itens do "Mais ações" (aberto). */
async function acoesOferecidas(): Promise<string[]> {
  const barra = barraDeAcoes();
  const naBarra: string[] = DA_BARRA.filter((r) => within(barra).queryByRole("button", { name: r }) !== null);
  const mais = within(barra).queryByRole("button", { name: "Mais ações" });
  let noMenu: string[] = [];
  if (mais) {
    await userEvent.setup().click(mais);
    const itens = await screen.findAllByRole("menuitem");
    noMenu = DO_MENU.filter((r) => itens.some((i) => nomeDe(i) === r));
  }
  return [...naBarra, ...noMenu];
}

describe("#3003 — paridade: nenhuma ação do cabeçalho desaparece", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: continua oferecendo exatamente ${cenario.esperadas.length} ações`, async () => {
      montar(cenario);
      const presentes = await acoesOferecidas();
      expect(
        [...presentes].sort(),
        `o conjunto de ações do cenário "${cenario.nome}" mudou — ação a menos (ou a mais) quebra a paridade do #3003`,
      ).toEqual([...cenario.esperadas].sort());
    });
  }

  it("a união dos cenários cobre TODA ação do inventário — é aqui que a ação removida do componente reprova", async () => {
    const vistas = new Set<string>();
    for (const cenario of CENARIOS) {
      const { unmount } = montar(cenario);
      for (const rotulo of await acoesOferecidas()) vistas.add(rotulo);
      unmount();
    }
    expect(
      INVENTARIO.filter((rotulo) => !vistas.has(rotulo)),
      "ação do inventário que NENHUM cenário oferece: ela saiu do componente, não do estado",
    ).toEqual([]);
    expect(vistas.size).toBe(INVENTARIO.length);
  });

  it("as ações do fluxo ficam À VISTA na barra, não dentro do menu", () => {
    montar(CENARIO_MAIS_COMPLETO);
    const barra = barraDeAcoes();
    for (const rotulo of ["Assumir", "Liberar", "Devolver à IA", "Transferir conversa", "Fechar conversa"]) {
      expect(within(barra).queryByRole("button", { name: rotulo }), `"${rotulo}" saiu da barra`).not.toBeNull();
    }
  });
});

describe("#3003 — guia curta: todo botão da barra diz o que faz", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: nome acessível e guia, em cada botão`, () => {
      montar(cenario);
      const alvos = Array.from(barraDeAcoes().querySelectorAll<HTMLElement>("button, a[href]"));
      expect(alvos.length, "a barra não renderizou botão nenhum").toBeGreaterThan(0);

      for (const el of alvos) {
        const nome = nomeDe(el);
        expect(nome, `botão sem nome acessível na barra: ${el.outerHTML}`).not.toBe("");
        if (GUIAS_DE_OUTROS_COMPONENTES.includes(nome)) continue;
        // A guia vai em `title` e NÃO substitui o nome acessível.
        expect(
          (el.getAttribute("title") ?? "").trim(),
          `"${nome}" não tem guia curta (#3003): quem está começando não sabe o que ele faz`,
        ).not.toBe("");
      }
    });
  }

  it("a guia não renomeou nenhum botão — o nome acessível continua sendo o rótulo", () => {
    montar(CENARIO_MAIS_COMPLETO);
    const barra = barraDeAcoes();
    for (const rotulo of ["Assumir", "Liberar", "Devolver à IA"]) {
      const botao = within(barra).getByRole("button", { name: rotulo });
      expect(botao.textContent?.trim()).toBe(rotulo);
    }
    // Os de ícone têm o nome pelo aria-label, e a guia é OUTRO texto.
    for (const rotulo of ["Transferir conversa", "Fechar conversa"]) {
      const botao = within(barra).getByRole("button", { name: rotulo });
      expect(botao.getAttribute("title")).not.toBe(rotulo);
    }
  });
});

/**
 * A GUIA DE "LIBERAR" DIZ PARA ONDE A CONVERSA VAI — e isso depende do estado.
 *
 * `fn_conversation_assign` (dono → null) só limpa `bot_silenced_until` quando não
 * houve escalação (`last_handoff_at is null`); trava do contato, opt-out e org sem
 * automático também deixam a conversa na fila. Uma guia fixa prometendo "o
 * automático assume de novo" mentiria em todos esses estados.
 */
describe("#3003 — a guia de Liberar não promete o automático quando ele não volta", () => {
  const VOLTA = "Solta esta conversa: ela fica sem dono e o atendimento automático volta a responder.";
  const FILA = "Solta esta conversa: ela fica sem dono e volta para a fila, esperando um atendente.";
  const minha = { assigned_to_user_id: "u1", assignee_kind: "user", bot_silenced_until: "infinity" };

  const casos: Array<{ nome: string; cenario: Partial<Cenario>; guia: string }> = [
    { nome: "assumida sem escalação, org com automático", cenario: { conversa: minha }, guia: VOLTA },
    {
      nome: "assumida DEPOIS de uma escalação — a RPC mantém o silêncio",
      cenario: { conversa: { ...minha, last_handoff_at: "2026-10-01T10:00:00Z" } },
      guia: FILA,
    },
    { nome: "org sem automático no ar", cenario: { conversa: minha, automaticoDaOrg: false }, guia: FILA },
    {
      nome: "contato travado (force_human) — Liberar não destrava",
      cenario: { conversa: minha, contato: { force_human: true } },
      guia: FILA,
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      montar({ nome: caso.nome, esperadas: [], ...caso.cenario });
      expect(screen.getByRole("button", { name: "Liberar" }).getAttribute("title")).toBe(caso.guia);
    });
  }
});
