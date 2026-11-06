import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import { CLASSES_DE_COR, LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { DEFAULT_APP_NAME, marcaEhADoProduto, type Branding } from "@/lib/branding";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { CORES_DA_MARCA, LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";

/**
 * A marca do PRODUTO aparece — e SÓ aparece — quando ninguém pôs a sua.
 *
 * O desenho vive em `lib/branding/desenho.ts` e a decisão em `marcaEhADoProduto`.
 * Este arquivo mede as duas metades: a regra pura, e a regra ALCANÇANDO a
 * barra lateral (conferir que a Sidebar importa o componente não bastaria — é
 * evidência de símbolo, não de comportamento).
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox", useRouter: () => ({ prefetch: vi.fn() }) }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
// O contador de casos lê a fila pelo React Query; aqui não há provider, e o
// número não é o objeto destes casos (o dele mora em contador-de-casos.test.tsx).
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;
const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;
let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => contexto }));

const PADRAO: Branding = { name: DEFAULT_APP_NAME, logoUrl: null, initial: "D" };

function renderSidebar(marca: Branding, collapsed: boolean) {
  return render(
    <MarcaDaInstalacaoProvider marca={marca}>
      {/* Na Inbox a barra começa recolhida; aberta = fixada na Inbox. */}
      <Sidebar collapsed={collapsed} fixoNaInbox={!collapsed} />
    </MarcaDaInstalacaoProvider>,
  );
}

afterEach(() => {
  cleanup();
  contexto = { user: usuario, activeOrg: org };
});

describe("marcaEhADoProduto", () => {
  it("é verdade só sem logo E com o nome padrão", () => {
    expect(marcaEhADoProduto(PADRAO)).toBe(true);
  });

  it("DECISÃO DO FORK: o padrão é Verdash CRM, e a instalação de produção (APP_NAME \"Verdash CRM\") mostra o V", () => {
    expect(DEFAULT_APP_NAME).toBe("Verdash CRM");
    expect(marcaEhADoProduto({ name: "Verdash CRM", logoUrl: null })).toBe(true);
    // CONTROLE: o nome antigo do upstream já não é a marca do produto aqui.
    expect(marcaEhADoProduto({ name: "DeskcommCRM", logoUrl: null })).toBe(false);
  });

  it("o logotipo soletra Verdash + CRM em caminhos (7 + 3 glifos)", () => {
    expect(LOGOTIPO.nome).toHaveLength(7);
    expect(LOGOTIPO.sufixo).toHaveLength(3);
  });

  it("quem trocou o nome NÃO recebe um logotipo que soletra outro nome", () => {
    expect(marcaEhADoProduto({ name: "Acme CRM", logoUrl: null })).toBe(false);
  });

  it("quem subiu logo já tem o dele", () => {
    expect(marcaEhADoProduto({ name: DEFAULT_APP_NAME, logoUrl: "https://cdn.x/logo.png" })).toBe(
      false,
    );
  });
});

describe("o desenho na barra lateral", () => {
  it("aberta e sem marca própria, mostra o logotipo do produto (SVG, não <img>)", () => {
    renderSidebar(PADRAO, false);
    const logotipo = screen.getByRole("img", { name: DEFAULT_APP_NAME });
    expect(logotipo.tagName.toLowerCase()).toBe("svg");
    // O e2e `marca-logo.spec.ts` lê "barra sem <img>" como "sem logo do
    // revendedor"; um <img> do produto aqui faria a spec medir a coisa errada.
    expect(document.querySelector("img")).toBeNull();
    // Nem o nome em texto: o logotipo já o escreve.
    expect(screen.queryByText(DEFAULT_APP_NAME)).toBeNull();
  });

  it("recolhida, o trilho mostra a sigla da organização, e não a marca (quadro DS, `.rail-tenant`)", () => {
    renderSidebar(PADRAO, true);
    expect(screen.getByTestId("sigla-da-organizacao")).toHaveTextContent("LD");
    // O logo mora no rodapé da 2ª coluna, que recolhida não aparece.
    expect(screen.queryByRole("img", { name: DEFAULT_APP_NAME })).toBeNull();
    expect(screen.queryByText("D")).toBeNull();
  });

  it("com nome da instalação, segue em texto — o desenho do produto não vaza", () => {
    renderSidebar({ name: "Sistema do Revendedor", logoUrl: null, initial: "S" }, false);
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
    expect(document.querySelector("svg[role=img]")).toBeNull();
  });

  it("com nome da ORGANIZAÇÃO sobre a instalação padrão, o nome dela vence o desenho", () => {
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    renderSidebar(PADRAO, false);
    expect(screen.getByText("Loja da Ana")).toBeTruthy();
    expect(document.querySelector("svg[role=img]")).toBeNull();
  });

  it("com logo da instalação, a imagem vence o desenho", () => {
    renderSidebar({ ...PADRAO, logoUrl: "https://cdn.exemplo.test/logo.png" }, false);
    expect(screen.getByRole("img").tagName.toLowerCase()).toBe("img");
  });
});

describe("as cores do desenho", () => {
  it("as classes do componente cobrem exatamente a paleta declarada, nos dois temas", () => {
    // O Tailwind só gera utilitário para hex LITERAL no fonte, então o
    // componente repete os valores. Isto é o que impede os dois de divergirem.
    const nasClasses = Object.values(CLASSES_DE_COR).join(" ").match(/#[0-9a-f]{6}/g) ?? [];
    const naPaleta = [...Object.values(CORES_DA_MARCA.claro), ...Object.values(CORES_DA_MARCA.escuro)];
    expect([...nasClasses].sort()).toEqual([...naPaleta].sort());
  });

  it("cada tema tem a sua classe: `dark:` no escuro, nada no claro", () => {
    for (const [papel, classes] of Object.entries(CLASSES_DE_COR)) {
      const chave = papel as keyof typeof CORES_DA_MARCA.claro;
      expect(classes).toContain(`fill-[${CORES_DA_MARCA.claro[chave]}]`);
      expect(classes).toContain(`dark:fill-[${CORES_DA_MARCA.escuro[chave]}]`);
    }
  });

  it("o símbolo é o V da Verdash: as peças com o degradê do arquivo, sem caixa de fundo", () => {
    render(<SimboloDoProduto nome="Marca X" />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(SIMBOLO.viewBox);
    const paradas = [...svg.querySelectorAll("stop")].map((p) => p.getAttribute("stop-color"));
    expect(paradas).toEqual(expect.arrayContaining(["#1042F6", "#00FFB0", "#FF3871", "#FF6F1B"]));
    // Cada peça pinta com o degradê DESTA instância; nada de retângulo de fundo.
    const pecas = [...svg.querySelectorAll("path")];
    expect(pecas).toHaveLength(3);
    for (const p of pecas) expect(p.getAttribute("fill")).toMatch(/^url\(#.+-simbolo-\d\)$/);
    expect(svg.querySelector("rect")).toBeNull();
    cleanup();
  });

  it("dois símbolos na mesma página não dividem o id do degradê", () => {
    render(
      <>
        <SimboloDoProduto nome="A" />
        <SimboloDoProduto nome="B" />
      </>,
    );
    const ids = [...document.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    cleanup();
  });

  it("decorativo esconde do leitor de tela; sem isso, nomeia a marca", () => {
    render(<SimboloDoProduto nome="Marca X" decorativo />);
    expect(document.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(<LogotipoDoProduto nome="Marca X" />);
    expect(screen.getByRole("img", { name: "Marca X" })).toBeTruthy();
  });
});

describe("o favicon segue a mesma regra", () => {
  const icone = fs.readFileSync(path.join(process.cwd(), "app/icon.tsx"), "utf8");

  it("desenha o símbolo quando a marca é a do produto, e a inicial quando não é", () => {
    expect(icone).toMatch(/marcaEhADoProduto\(\{ name: marca\.nome, logoUrl: marca\.logoUrl \}\)/);
    // Chamada como FUNÇÃO: a forma JSX (`<CamadasDoSimbolo />`) quebra o satori
    // ("Only intrinsic elements are supported inside <svg>") e dava 500 no ícone.
    expect(icone).toMatch(/CamadasDoSimbolo\(\{ prefixo: "icone" \}\)/);
    expect(icone).toMatch(/letraDoIcone\(marca\.nome\)/);
  });
});

describe("o cabeçalho do onboarding segue a mesma regra do favicon", () => {
  const layout = fs.readFileSync(path.join(process.cwd(), "app/onboarding/layout.tsx"), "utf8");

  it("a marca padrão segue com o SVG que acompanha o tema, e o <img> só vale para marca própria", () => {
    // O `/icon` é um PNG sempre claro: desenhá-lo para a marca padrão punha um
    // ladrilho creme no tema escuro (PR #1942). A escolha passa pela MESMA regra
    // de `app/icon.tsx`, e o SVG vem antes do <img>.
    expect(layout).toMatch(
      /iconeUrl === ICONE_DESENHADO &&\s*marcaEhADoProduto\(\{ name: marcaDoIcone\.nome, logoUrl: marcaDoIcone\.logoUrl \}\)/,
    );
    expect(layout).toMatch(/simboloDoProduto \? \(\s*<SimboloDoProduto[^>]*decorativo/);
  });

  it("o ícone é decorativo: o nome já está escrito ao lado", () => {
    const img = layout.slice(layout.indexOf("<img"), layout.indexOf("/>", layout.indexOf("<img")));
    expect(img).toMatch(/alt=""/);
  });
});
