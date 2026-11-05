/**
 * M1.4 do app de celular: a folha inferior (título, fechar, Esc), a folha "Criar"
 * do FAB (opções da tela, destino de cada uma) e o gesto de deslizar (eixo
 * horizontal abre, vertical não; tocar na linha aberta fecha sem abrir a conversa;
 * ações fora do leitor e do Tab enquanto fechada).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ rota: "/app/inbox", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.rota,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: false, support: null },
    activeOrg: { role: "admin", interface_settings: undefined, modulos_ligados: [], capacidades_ligadas: [] },
  }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: (habilitado: boolean) => ({ data: habilitado ? { pipeline: { id: "p-9" } } : undefined }),
}));

import { FolhaInferior } from "@/components/mobile/FolhaInferior";
import { LinhaDeslizante } from "@/components/mobile/LinhaDeslizante";
import { FolhaCriar } from "@/components/mobile/telas/FolhaCriar";
import { Archive, PushPin } from "@/lib/ui/icons";

beforeEach(() => {
  nav.rota = "/app/inbox";
  nav.push.mockClear();
});

describe("folha inferior", () => {
  it("abre com título e fecha pelo botão e pelo Esc", () => {
    const aoMudar = vi.fn();
    render(
      <FolhaInferior aberto aoMudar={aoMudar} titulo="Criar">
        <p>conteúdo</p>
      </FolhaInferior>,
    );
    expect(screen.getByRole("dialog", { name: "Criar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(aoMudar).toHaveBeenCalledWith(false);
    aoMudar.mockClear();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(aoMudar).toHaveBeenCalledWith(false);
  });
});

describe("folha Criar", () => {
  it("Conversas: as 5 opções do protótipo, na ordem", () => {
    render(<FolhaCriar aberta aoMudar={vi.fn()} />);
    const titulos = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(titulos.filter((t) => t.startsWith("Nov"))).toEqual([
      "Nova conversaPrimeira mensagem para um contato",
      "Novo contatoPessoa ou empresa na base",
      "Novo leadNegócio aberto em um funil",
      "Nova tarefaPróximo passo com prazo e responsável",
      "Novo compromissoHorário marcado na agenda",
    ]);
  });

  it("Novo lead fora do funil vai para o funil padrão, abrindo a criação", () => {
    const aoMudar = vi.fn();
    render(<FolhaCriar aberta aoMudar={aoMudar} />);
    fireEvent.click(screen.getByRole("button", { name: /Novo lead/ }));
    expect(aoMudar).toHaveBeenCalledWith(false);
    expect(nav.push).toHaveBeenCalledWith("/app/pipelines/p-9?criar=1");
  });
});

describe("folha Criar respeita o menu do vínculo (P2 do Cassio na #177)", () => {
  it("opção cuja tela não está no menu some", async () => {
    const { opcoesPermitidas } = await import("@/lib/mobile/abas");
    const todas = ["conversa", "contato", "lead", "tarefa", "compromisso"] as const;
    const semAgendaNemInbox = new Set(["/app/contacts", "/app/kanban", "/app/tasks"]);
    expect(opcoesPermitidas([...todas], semAgendaNemInbox)).toEqual(["contato", "lead", "tarefa"]);
    expect(opcoesPermitidas([...todas], new Set())).toEqual([]);
  });
});

describe("gesto de deslizar", () => {
  const montar = (aoAbrir = vi.fn(), aoArquivar = vi.fn()) => {
    render(
      <LinhaDeslizante
        esquerda={[{ id: "fixar", rotulo: "Fixar", icone: PushPin, fundo: "", aoTocar: vi.fn() }]}
        direita={[{ id: "arquivar", rotulo: "Arquivar", icone: Archive, fundo: "", aoTocar: aoArquivar }]}
      >
        <button type="button" onClick={aoAbrir}>
          Maria
        </button>
      </LinhaDeslizante>,
    );
    const linha = screen.getByText("Maria").parentElement!;
    return { linha, aoAbrir, aoArquivar };
  };
  const arrastar = (el: HTMLElement, dx: number, dy: number) => {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 200 + dx, clientY: 100 + dy });
  };

  it("fechada: ações fora do leitor e do Tab", () => {
    const { linha } = montar();
    const acoes = linha.previousElementSibling as HTMLElement;
    expect(acoes).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Arquivar").closest("button")).toHaveAttribute("tabindex", "-1");
  });

  it("arrastar na horizontal abre; tocar na linha aberta fecha sem abrir a conversa", () => {
    const { linha, aoAbrir } = montar();
    linha.setPointerCapture = vi.fn();
    arrastar(linha, -120, 4);
    expect(linha.style.transform).toBe("translateX(-72px)");
    fireEvent.click(screen.getByText("Maria"));
    expect(aoAbrir).not.toHaveBeenCalled();
    expect(linha.style.transform).toBe("");
  });

  it("arrastar na vertical é rolagem: a linha não mexe", () => {
    const { linha } = montar();
    linha.setPointerCapture = vi.fn();
    arrastar(linha, 10, 80);
    expect(linha.style.transform).toBe("");
  });

  it("a ação revelada age e a linha fecha", () => {
    const { linha, aoArquivar } = montar();
    linha.setPointerCapture = vi.fn();
    arrastar(linha, -120, 0);
    fireEvent.click(screen.getByText("Arquivar"));
    expect(aoArquivar).toHaveBeenCalledTimes(1);
    expect(linha.style.transform).toBe("");
  });
});

describe("popovers e menus que viram folha no celular", () => {
  it("filtros, menu da conversa (e submenus), ⋮ do cabeçalho, transferir, anexar e avisos", async () => {
    const { readFileSync } = await import("node:fs");
    for (const arquivo of [
      "components/inbox/filtros/PopoverDeFiltros.tsx",
      "components/inbox/menu/ConteudoDoMenu.tsx",
      "components/inbox/menu/SubmenusDaConversa.tsx",
      "components/inbox/menu/SubmenuDoFunil.tsx",
      "components/inbox/menu/ItensPessoais.tsx",
      "components/inbox/cabecalho/MaisAcoes.tsx",
      "components/inbox/cabecalho/TransferirPopover.tsx",
      "components/inbox/composer/AttachMenu.tsx",
      "components/shell/AlertsBell.tsx",
    ]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/<(PopoverContent|DropdownMenuContent|DropdownMenuSubContent) folhaNoCelular/);
    }
    // E a regra que dá a forma de folha só vale abaixo de 760px, com as medidas do protótipo.
    const css = readFileSync("app/globals.css", "utf8");
    const bloco = css.slice(css.indexOf("@media (max-width: 759px) {"), css.indexOf("@media (max-width: 759px) and (prefers-reduced-motion"));
    for (const token of ["--mb-folha-max", "--mb-folha-raio", "--mb-pegador-largura", "--mb-area-baixo"]) {
      expect(bloco, token).toContain(`var(${token})`);
    }
  });
});
