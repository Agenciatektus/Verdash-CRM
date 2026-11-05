/**
 * A casca do app de celular (M1.3): qual aba acende em cada rota, quando a barra some,
 * onde o FAB aparece e o que os contadores dizem. As consultas dos contadores são as
 * MESMAS do menu (mockadas aqui), sem consulta nova.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { abaDaRota, destinoDeCriar, ehRaizDeAba, ehTelaCheia, opcoesDeCriar, voltarDaRota } from "@/lib/mobile/abas";

const nav = vi.hoisted(() => ({ rota: "/app/inbox", busca: new URLSearchParams(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.rota,
  useSearchParams: () => nav.busca,
  useRouter: () => ({ push: nav.push, back: nav.back }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: { orgId: "o-1" } }) }));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({ useConversationCounts: () => ({ data: { fila: 3 } }) }));
const contagens = vi.hoisted(() => ({ chamadas: 0 }));
vi.mock("@/hooks/tasks/useTarefasAtrasadas", () => ({
  useTarefasAtrasadas: () => {
    contagens.chamadas += 1;
    return { data: 2 };
  },
}));
vi.mock("@/hooks/ai/useAgentInbox", () => ({ useAgentInbox: () => ({ data: { open_count: 0 } }) }));

import { BarraDeTela } from "@/components/mobile/BarraDeTela";
import { BarraInferior } from "@/components/mobile/BarraInferior";

beforeEach(() => {
  // Abaixo de 760px: é só lá que a barra monta os contadores (`useEhCelular`).
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  nav.rota = "/app/inbox";
  nav.busca = new URLSearchParams();
  nav.push.mockClear();
  nav.back.mockClear();
  window.sessionStorage.clear();
  contagens.chamadas = 0;
});

describe("rotas do app de celular", () => {
  it("cada rota acende a sua aba; o resto é do Mais", () => {
    expect(abaDaRota("/app/inbox")).toBe("conversas");
    expect(abaDaRota("/app/pipelines/p-1")).toBe("funil");
    expect(abaDaRota("/app/leads/l-1")).toBe("funil");
    expect(abaDaRota("/app/agenda")).toBe("tarefas");
    expect(abaDaRota("/app/ai/inbox")).toBe("avisos");
    expect(abaDaRota("/app/ai/agents")).toBe("mais");
    expect(abaDaRota("/app/settings/profile")).toBe("mais");
  });

  it("o voltar de quem chegou por link: Ajustes volta à lista de seções", () => {
    expect(voltarDaRota("/app/settings/profile")).toBe("/app/settings");
    expect(voltarDaRota("/app/settings/tenant/pipelines")).toBe("/app/settings");
    expect(voltarDaRota("/app/settings")).toBe("/app");
    expect(voltarDaRota("/app/team")).toBe("/app");
    expect(voltarDaRota("/app/ai/agents")).toBe("/app/ai");
    expect(voltarDaRota("/app/ai")).toBe("/app");
    expect(voltarDaRota("/app/leads/l-1")).toBe("/app/kanban");
  });

  it("começo de aba x tela empilhada", () => {
    expect(ehRaizDeAba("/app/tasks")).toBe(true);
    expect(ehRaizDeAba("/app/pipelines/p-1")).toBe(false);
  });

  it("tela cheia: conversa aberta e ficha do lead", () => {
    expect(ehTelaCheia("/app/inbox", "c-1")).toBe(true);
    expect(ehTelaCheia("/app/inbox/c-1", null)).toBe(true);
    expect(ehTelaCheia("/app/leads/l-1", null)).toBe(true);
    expect(ehTelaCheia("/app/inbox", null)).toBe(false);
    expect(ehTelaCheia("/app/ai/followups/f-1", null)).toBe(true);
    expect(ehTelaCheia("/app/ai/atendimento/f-1", null)).toBe(true);
    expect(ehTelaCheia("/app/ai/followups/enrollments", null)).toBe(false);
    expect(ehTelaCheia("/app/ai/followups", null)).toBe(false);
  });

  it("FAB só onde há o que criar, com as opções do protótipo na ordem", () => {
    expect(opcoesDeCriar("/app/inbox")).toEqual(["conversa", "contato", "lead", "tarefa", "compromisso"]);
    expect(opcoesDeCriar("/app/kanban")).toEqual(["lead", "contato", "tarefa"]);
    expect(opcoesDeCriar("/app/pipelines/p-1")).toEqual(["lead", "contato", "tarefa"]);
    expect(opcoesDeCriar("/app/tasks")).toEqual(["tarefa", "compromisso", "lead"]);
    expect(opcoesDeCriar("/app/ai/inbox")).toEqual([]);
  });

  it("cada opção leva à tela que já cria aquilo, com ?criar=1", () => {
    expect(destinoDeCriar("contato", "/app/inbox", null)).toBe("/app/contacts?criar=1");
    expect(destinoDeCriar("tarefa", "/app/inbox", null)).toBe("/app/tasks?criar=1");
    expect(destinoDeCriar("compromisso", "/app/tasks", null)).toBe("/app/agenda?criar=1");
    expect(destinoDeCriar("lead", "/app/pipelines/p-1", "p-9")).toBe("/app/pipelines/p-1?criar=1");
    expect(destinoDeCriar("lead", "/app/inbox", "p-9")).toBe("/app/pipelines/p-9?criar=1");
    expect(destinoDeCriar("lead", "/app/inbox", null)).toBe("/app/kanban");
  });

  it("com a conversa aberta, a tarefa fica na conversa (presa a ela) e mantém os filtros da URL", () => {
    expect(destinoDeCriar("tarefa", "/app/inbox", null, "id=c-1")).toBe("/app/inbox?id=c-1&tarefa=1");
    expect(destinoDeCriar("tarefa", "/app/inbox", null, "aba=minhas&id=c-1")).toBe("/app/inbox?aba=minhas&id=c-1&tarefa=1");
  });

  it("sem conversa aberta (lista, funil, tarefas), a tarefa segue para a tela de Tarefas", () => {
    expect(destinoDeCriar("tarefa", "/app/inbox", null, "aba=minhas")).toBe("/app/tasks?criar=1");
    expect(destinoDeCriar("tarefa", "/app/kanban", null, "id=c-1")).toBe("/app/tasks?criar=1");
  });
});

describe("barra inferior", () => {
  const montar = () => render(<BarraInferior maisAberto={false} aoAbrirMais={vi.fn()} />);

  it("5 abas na ordem, só no celular, com a aba da rota acesa", () => {
    montar();
    const barra = screen.getByRole("navigation", { name: "Seções do CRM" });
    expect(barra.className).toMatch(/\bhidden\b/);
    expect(barra.className).toContain("mb:grid");
    const nomes = [...barra.querySelectorAll("a, button")].map((el) => el.textContent);
    expect(nomes).toEqual(["3Conversas", "Funil", "2Tarefas", "Avisos", "Mais"]);
    expect(screen.getByRole("link", { name: "Conversas, 3 esperando uma pessoa" })).toHaveAttribute("aria-current", "page");
  });

  it("contador zero não aparece, e o nome acessível diz o número", () => {
    montar();
    expect(screen.getByRole("link", { name: "Tarefas, 2 atrasadas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Avisos" })).toBeInTheDocument();
  });

  it("some na tela cheia (conversa aberta)", () => {
    nav.busca = new URLSearchParams("id=c-1");
    montar();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("tocar de novo na aba acesa volta ao começo dela", () => {
    nav.rota = "/app/pipelines/p-1";
    montar();
    fireEvent.click(screen.getByRole("link", { name: "Funil" }));
    expect(nav.push).toHaveBeenCalledWith("/app/kanban");
  });

  it("no desktop a barra não faz consulta nenhuma (contadores só abaixo de 760px)", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    montar();
    expect(screen.getByRole("link", { name: "Conversas" })).toBeInTheDocument();
    expect(contagens.chamadas).toBe(0);
  });

  it("Mais abre o menu", () => {
    const aoAbrirMais = vi.fn();
    render(<BarraInferior maisAberto={false} aoAbrirMais={aoAbrirMais} />);
    fireEvent.click(screen.getByRole("button", { name: "Mais" }));
    expect(aoAbrirMais).toHaveBeenCalledTimes(1);
  });
});

describe("voltar do celular", () => {
  it("quem chegou por link (nada do app atrás) vai ao começo da aba, e não sai do CRM", () => {
    render(<BarraDeTela titulo="Perfil" voltarPara="/app" />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(nav.back).not.toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledWith("/app");
  });

  it("com tela do app atrás, volta pelo histórico", () => {
    window.sessionStorage.setItem("crm-telas-do-app-atras", "1");
    render(<BarraDeTela titulo="Perfil" voltarPara="/app" />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(nav.back).toHaveBeenCalledTimes(1);
  });
});
