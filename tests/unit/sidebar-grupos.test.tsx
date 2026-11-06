/**
 * Sidebar agrupado por objetivo. O que estes testes protegem:
 *
 *  - a hierarquia existe (o usuário reclamou de 17 itens no mesmo peso visual);
 *  - Funis é alcançável sem passar por Configurações — o achado que originou tudo;
 *  - agrupar não criou cabeçalho órfão (grupo cujos filhos a permissão filtrou);
 *  - colapsado não renderiza título nenhum: 6 rótulos em 64px seria ilegível.
 *
 * ⚠️ VISUAL V2 (fase 2): a barra do desktop virou DUAS colunas, um trilho com
 * um botão por grupo e a coluna com as telas do grupo escolhido (o da rota, até
 * alguém pedir outro no trilho). As propriedades acima continuam as mesmas; o
 * que mudou é o caminho: para ver as telas de um grupo que não é o da rota, o
 * caso clica no botão do grupo, como quem usa faria. E como a coluna dos grupos
 * COM hub mostra o inventário inteiro (o mesmo do hub), telas que tinham saído
 * do menu só por falta de espaço (Etapas do funil, Audit Log, Roteadores)
 * voltam a aparecer DENTRO do grupo certo, que é o que estes casos sempre
 * prenderam: a porta é o grupo, nunca Configurações.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import type * as IdiomaProviderModulo from "@/lib/i18n/IdiomaProvider";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn() }),
  usePathname: () => "/app/inbox",
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
// Os contadores leem pelo React Query; aqui não há provider, e o NÚMERO não é
// o objeto destes casos (mora em contador-de-casos/contador-da-fila.test.tsx).
// O dublê desenha um marcador vazio: o que se mede aqui é ONDE o Sidebar o põe.
vi.mock("@/components/shell/ContadorDeCasos", () => ({
  ContadorDeCasos: ({ compacto }: { compacto: boolean }) => (
    <span data-testid="marcador-casos" data-compacto={String(compacto)} />
  ),
}));
vi.mock("@/components/shell/ContadorDaFila", () => ({
  ContadorDaFila: ({ compacto }: { compacto: boolean }) => (
    <span data-testid="marcador-fila" data-compacto={String(compacto)} />
  ),
}));
vi.mock("@/components/shell/ContadorDeTarefas", () => ({ ContadorDeTarefas: () => null }));
vi.mock("@/hooks/pipelines/useLeadsAbertosPorFunil", () => ({ useLeadsAbertosPorFunil: () => ({ data: {} }) }));
vi.mock("@/components/shell/ContadorDeAvisos", () => ({
  ContadorDeAvisos: () => <span data-testid="marcador-avisos" />,
}));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({
  toggleSidebar: vi.fn(),
}));
// Busca a versão via react-query; sem QueryClientProvider ele lança, e o
// rodapé de versão não é o que estes testes examinam.
vi.mock("@/components/shell/VersionFooter", () => ({
  VersionFooter: () => null,
}));

// O rótulo CURTO do trilho depende do idioma; o resto do arquivo roda em pt-BR.
const idiomaRef: { valor: "pt-BR" | "es" } = { valor: "pt-BR" };
vi.mock("@/lib/i18n/IdiomaProvider", async (original) => ({
  ...(await original<typeof IdiomaProviderModulo>()),
  useIdioma: () => idiomaRef.valor,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(() => {
  idiomaRef.valor = "pt-BR";
  cleanup();
});

/** O trilho: um botão por grupo, na ordem do registro. */
const trilho = () => screen.getByRole("navigation", { name: "Grupos da navegação" });
const nomesDosGrupos = () =>
  within(trilho())
    .getAllByRole("button")
    .map((b) => b.textContent?.trim());
/** A coluna 2: as telas do grupo mostrado. */
const coluna = () => screen.getByRole("navigation", { name: "Navegação principal" });
async function abrirGrupo(nome: string) {
  await userEvent.click(within(trilho()).getByRole("button", { name: nome }));
}

describe("Sidebar agrupado", () => {
  it("renderiza os grupos na ordem de uso", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    // Organização não está no trilho: seu hub (Configurações) é o link Ajustes do
    // rodapé fixo, fora da área que rola — medido, ele caía fora da dobra até em
    // 1080px. "Agentes" no plural é decisão do produto (era "Agente").
    expect(nomesDosGrupos()).toEqual(["Conversas", "CRM", "Agentes", "Canais", "Análise"]);
    // A coluna tem UM título: o do grupo mostrado, que começa sendo o da rota.
    expect(screen.getAllByRole("heading").map((el) => el.textContent?.trim())).toEqual([
      "Conversas",
    ]);
  });

  it("leva às Etapas do funil pelo CRM, e não por Configurações", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    // ⚠️ O CAMINHO MUDOU, A PROPRIEDADE NÃO. Etapas do funil saiu do menu para
    // dentro do hub do CRM quando Tarefas virou o quinto destino do grupo e o
    // menu passou a rolar. A porta continua sendo CRM — "Ver tudo em CRM" leva
    // a `/app/crm`, e é lá que a tela aparece —, nunca Configurações, que é o
    // enterro que originou toda esta reorganização.
    //
    // ⚠️ TEKTUS 21/09/2026 — Etapas do funil SAIU do menu de novo, e o teste
    // volta a prender o que sempre foi a propriedade: a porta é o CRM. O pedido
    // do "pipeline no menu" é atendido pelo nó "Pipeline"
    // (`tests/unit/no-de-funis-no-menu.test.tsx`).
    //
    // ⚠️ VISUAL V2 — a coluna do CRM mostra o inventário do grupo, e Etapas do
    // funil volta a aparecer, na seção "Preparar a venda", DENTRO do CRM. A
    // propriedade fica mais forte, não mais fraca: a porta é o grupo certo.
    //
    // ⚠️ 09/10/2026 — o "Ver tudo em CRM" saiu do fim da coluna (decisão do
    // Peterson, seguindo o protótipo): a coluna já é o inventário inteiro.
    await abrirGrupo("CRM");
    expect(within(coluna()).queryByRole("link", { name: /Ver tudo em/ })).toBeNull();
    expect(within(coluna()).getByRole("link", { name: "Etapas do funil" })).toHaveAttribute(
      "href",
      "/app/settings/tenant/pipelines",
    );
    expect(within(coluna()).getByRole("link", { name: "Tarefas" })).toHaveAttribute(
      "href",
      "/app/tasks",
    );
  });

  it("o número de Casos mora no item de Casos, e o da Fila no item de Inbox", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    // No trilho, cada contador vira ponto no botão do grupo que contém a tela:
    // é o aviso de que há o que fazer num grupo que a coluna não está mostrando.
    const casosNoTrilho = within(trilho()).getByTestId("marcador-casos");
    expect(casosNoTrilho).toHaveAttribute("data-compacto", "true");
    expect(casosNoTrilho.closest("button")).toHaveTextContent("Agentes");
    const filaNoTrilho = within(trilho()).getByTestId("marcador-fila");
    expect(filaNoTrilho.closest("button")).toHaveTextContent("Conversas");
    // Na coluna, o número inteiro fica no item da tela.
    const filaNaColuna = within(coluna()).getAllByTestId("marcador-fila");
    expect(filaNaColuna).toHaveLength(1);
    expect(filaNaColuna[0]!.closest("a")).toHaveAttribute("href", "/app/inbox");
    expect(filaNaColuna[0]).toHaveAttribute("data-compacto", "false");

    await abrirGrupo("Agentes");
    const casosNaColuna = within(coluna()).getAllByTestId("marcador-casos");
    expect(casosNaColuna).toHaveLength(1);
    expect(casosNaColuna[0]!.closest("a")).toHaveAttribute("href", "/app/ai/cases");
    // Roteadores tinha saído do menu para Casos caber (a folga era menos de uma
    // linha). Na coluna de IA, que tem o espaço do hub, ele volta ao grupo dele.
    expect(within(coluna()).getByRole("link", { name: "Roteadores" })).toBeTruthy();
    cleanup();
    // Recolhido, o contador vira ponto — é o componente que decide, com esta dica.
    render(<Sidebar collapsed />);
    expect(screen.getByTestId("marcador-casos")).toHaveAttribute("data-compacto", "true");
  });

  it("e os dois itens de funil não disputam o mesmo nome", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    await abrirGrupo("CRM");
    expect(screen.getByRole("link", { name: "Funis" })).toHaveAttribute("href", "/app/kanban");
  });

  it("desenterra Audit Log — e Nuvemshop voltou ao menu, por escolha", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    // ⚠️ O CAMINHO MUDOU, A PROPRIEDADE NÃO. O que esta linha sempre prendeu é
    // que Audit Log deixou de existir só como card enterrado em Configurações.
    // Quando Atividades (PR #583) virou o quinto destino do grupo Análise, Audit
    // Log foi para o hub do grupo. Na barra de duas colunas, a coluna de Análise
    // mostra esse inventário, e Audit Log volta a ter linha própria NELA.
    await abrirGrupo("Análise");
    expect(within(coluna()).getByRole("link", { name: /Audit Log/ })).toHaveAttribute(
      "href",
      "/app/audit",
    );

    // NUVEMSHOP VOLTOU, e esta linha já mudou de lado duas vezes — por isso ela
    // guarda o MOTIVO, e não só o resultado. A integração foi "desenterrada"
    // para o menu por não ter link nenhum; o dono do produto do upstream pediu
    // para ocultá-la, porque não usava a integração; nesta instalação ela passou
    // a ser usada, com o app de parceiro próprio e cada empresa conectando a
    // própria loja.
    //
    // O grupo "canais" não tem hub, então a coluna mostra só o que vai para o
    // menu: aqui, aparecer ou não é decisão, nunca falta de espaço. Enquanto
    // esteve fora, a rota e a página seguiram de pé e só o ⌘K achava
    // (`searchable()` filtra por papel, nunca por `sidebar`) — e foi
    // exatamente isso que fez alguém no meio da conexão não achar a tela de volta.
    await abrirGrupo("Canais");
    expect(within(coluna()).getByRole("link", { name: /Nuvemshop/ })).toHaveAttribute(
      "href",
      "/app/integrations/nuvemshop",
    );
  });

  it("Configurações fica no rodapé, nunca dependendo de scroll, e abre a coluna 2", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    // No trilho de 72px o rótulo é curto ("Ajustes").
    const config = screen.getByRole("button", { name: /Ajustes/ });
    // Fora das duas áreas que rolam (o trilho de grupos e a coluna).
    expect(coluna().contains(config)).toBe(false);
    expect(trilho().contains(config)).toBe(false);
    // S20 da auditoria: Ajustes abre a coluna 2 com as seções de Configurações,
    // como os outros grupos, em vez de levar direto ao hub.
    await userEvent.click(config);
    expect(config).toHaveAttribute("aria-pressed", "true");
    expect(within(coluna()).getByRole("link", { name: "Perfil" })).toHaveAttribute(
      "href",
      "/app/settings/profile",
    );
  });

  it("recolhida: parar o mouse num grupo espia a coluna, e sair da barra fecha (S6)", () => {
    vi.useFakeTimers();
    try {
      comoPapel("admin");
      render(<Sidebar collapsed />);
      const atendimento = within(trilho()).getByRole("button", { name: "Conversas" });
      fireEvent.pointerOver(atendimento, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(atendimento).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
      // Espiar não rouba o foco de quem só passou o mouse.
      expect(screen.getByRole("link", { name: /Inbox/ })).not.toHaveFocus();
      fireEvent.pointerOut(atendimento.closest("aside")!.firstElementChild!, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aberta por CLIQUE, a coluna não fecha quando o mouse sai da barra (P2-1 da #146)", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    const atendimento = within(trilho()).getByRole("button", { name: "Conversas" });
    await userEvent.click(atendimento);
    expect(atendimento).toHaveAttribute("aria-expanded", "true");
    vi.useFakeTimers();
    try {
      fireEvent.pointerOut(atendimento.closest("aside")!.firstElementChild!, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole("link", { name: /Inbox/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("não deixa grupo órfão quando a permissão esvazia o grupo", () => {
    // CANAIS é todo manager+/admin. Um agent não pode ver o botão sozinho.
    comoPapel("agent");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    expect(nomesDosGrupos()).not.toContain("Canais");
    expect(nomesDosGrupos()).toContain("Conversas");
  });

  it("a coluna não repete o hub no fim: ela já é o inventário do grupo", async () => {
    // Decisão do Peterson (09/10/2026), seguindo o protótipo. O hub segue na rota
    // e no menu do celular, que não tem a coluna (`SidebarContent`).
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    await abrirGrupo("Agentes");
    expect(screen.queryByRole("link", { name: /Ver tudo em IA/ })).toBeNull();
    // Controle: a coluna está mesmo aberta, com as telas do grupo.
    expect(within(coluna()).getByRole("link", { name: "Roteadores" })).toBeTruthy();
  });

  it("colapsado esconde os títulos e abre as telas do grupo por cima", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    // Recolhida, a barra é só o trilho: nenhum título, nenhuma tela à vista.
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
    // O botão do grupo abre a coluna como sobreposição, e diz isso ao leitor de tela.
    const atendimento = within(trilho()).getByRole("button", { name: "Conversas" });
    expect(atendimento).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(atendimento);
    expect(atendimento).toHaveAttribute("aria-expanded", "true");
    // O foco vai para a 1ª tela da coluna: quem abriu pelo teclado está a um Tab dela.
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveFocus();
    // Esc fecha e devolve o foco ao botão que abriu.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
    expect(atendimento).toHaveFocus();
  });

  it("o peek fecha quando o foco sai da barra, e não fecha num Esc já tratado", async () => {
    comoPapel("admin");
    render(
      <>
        <Sidebar collapsed />
        <button type="button">fora da barra</button>
      </>,
    );
    const atendimento = within(trilho()).getByRole("button", { name: "Conversas" });
    await userEvent.click(atendimento);
    // Um Esc que o ⌘K ou um modal já consumiram não fecha o peek de carona.
    const inbox = screen.getByRole("link", { name: /Inbox/ });
    inbox.addEventListener("keydown", (e) => e.preventDefault());
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("link", { name: /Inbox/ })).toBeTruthy();
    // Foco para fora da barra inteira fecha. `focus()` e não clique: o clique fecha
    // pelo `pointerdown`, e aqui o que se mede é o `focusout`.
    act(() => screen.getByRole("button", { name: "fora da barra" }).focus());
    expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
  });

  it("expandir a barra zera o peek", async () => {
    comoPapel("admin");
    const { rerender } = render(<Sidebar collapsed />);
    await userEvent.click(within(trilho()).getByRole("button", { name: "Conversas" }));
    rerender(<Sidebar collapsed={false} fixoNaInbox />);
    rerender(<Sidebar collapsed />);
    // Recolhida de novo, a sobreposição não reaparece sozinha.
    expect(screen.queryByRole("link", { name: /Inbox/ })).toBeNull();
  });

  it("na Inbox a 2ª coluna começa recolhida, mesmo com a preferência geral aberta (quadro DS)", () => {
    comoPapel("admin");
    const { container } = render(<Sidebar collapsed={false} />);
    expect(container.querySelector("aside")?.className).toContain("w-[72px]");
    expect(screen.getByRole("button", { name: "Fixar menu" })).toBeInTheDocument();
  });

  it("marca a rota atual com aria-current", async () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    expect(screen.getByRole("link", { name: /Inbox/ })).toHaveAttribute("aria-current", "page");
    // "Kanban" saiu da interface; o item da mesma URL agora se chama "Funis".
    await abrirGrupo("CRM");
    expect(screen.getByRole("link", { name: "Funis" })).not.toHaveAttribute("aria-current");
  });
});

describe("rótulo curto do trilho", () => {
  it("em espanhol o grupo Conversas aparece como 'Chats' só no trilho", () => {
    // "Conversaciones" não cabe nos 64px do botão; o título (dica) mantém o nome
    // completo traduzido, e o dicionário de "Conversas" não muda para o resto do
    // produto (tabelas usam a mesma chave em outro sentido).
    idiomaRef.valor = "es";
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    const botao = within(trilho()).getByRole("button", { name: "Chats" });
    expect(botao).toHaveAttribute("title", "Conversas");
  });

  it("em português o trilho usa o próprio rótulo do grupo", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} fixoNaInbox />);
    expect(within(trilho()).getByRole("button", { name: "Conversas" })).toBeTruthy();
  });
});
