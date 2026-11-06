import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";

/**
 * #885 — o papel de leitura não ganha porta de escrita na Agenda.
 *
 * O piso da escrita é o mesmo da rota (`requireRole("agent")`) e já existia
 * nesta tela: a prop `podeMarcar` (antes `podeMarcarEncaixe`, que só cobria o
 * encaixe do painel) é quem responde por ele. Antes deste teste, três gestos
 * apareciam para o papel "Somente leitura" e a recusa só chegava no 403 da
 * rota, DEPOIS do gesto: o botão "Novo agendamento", o clique num bloco livre
 * da grade e o painel que se abre sozinho pelo "Marcar compromisso" do Inbox.
 *
 * Aqui o contrato é o do RENDER: com `podeMarcar={false}` não existe botão,
 * não existe motivo ao lado dele e a grade não oferece bloco clicável — e com
 * `podeMarcar={true}` as três coisas existem, provando que o gate é o papel e
 * não um render quebrado. A quarta porta (o deep-link) não tem superfície
 * própria para asseverar aqui: ela é a ausência do painel, coberta pelo mesmo
 * `podeMarcar` em `_client.tsx`.
 *
 * Isto NÃO substitui a spec de e2e: aqui não há rota, sessão nem papel de
 * verdade — o papel chega já resolvido pela prop, como em `page.tsx`.
 */

// A tela pergunta a largura da janela num efeito (a visão padrão muda no
// celular) e o ambiente de teste não traz `matchMedia`: sem o stub o render
// morre em `window.matchMedia is not a function`, que não é o que este teste
// mede — a largura é irrelevante para o piso de escrita.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("1023px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/app/agenda",
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u1" }, activeOrg: { id: "o1", role: "agent" } }),
}));

// `useT` devolve, nas telas, a função que traduz — e é chamada das duas
// formas (`const t = useT()` e `const { t } = useT()`). A função com a
// propriedade `.t` apontando para si mesma atende às duas, sem depender de
// qual delas esta tela usa hoje.
const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));

// O `Locale` do date-fns é OBJETO: devolver a etiqueta "pt-BR" aqui derrubava
// o render dentro do `format()` do date-fns.
vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({
    data: { slots: [], fuso_da_regra: "America/Sao_Paulo", publicou_horarios: true },
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: [], isError: false, isLoading: false }),
}));

vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: [], isError: false, isLoading: false }),
}));

const registrarVinculoDaRota = vi.fn(() => false);
vi.mock("@/lib/agenda/vinculo-da-marcacao", () => ({
  useVinculoDaMarcacao: () => ({
    vinculo: { contact: null, conversation: null },
    registrarRota: registrarVinculoDaRota,
    reiniciar: vi.fn(),
    escolher: vi.fn(),
    escolherVinculo: vi.fn(),
  }),
}));

const TIPOS = [
  {
    id: "tipo-1",
    nome: "Consulta",
    duracaoMin: 30,
    donoId: null,
    localKind: null,
    localDetalhes: null,
  },
];

let usuario = "u1";
let org = "o1";

function montar({
  podeMarcar,
  tipos = TIPOS,
}: {
  podeMarcar: boolean;
  tipos?: typeof TIPOS;
}) {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        // A data de hoje NO FUSO DA ORGANIZAÇÃO, que o servidor resolve e a tela
        // usa para ancorar a semana (#1350). É prop obrigatória de propósito:
        // um default aqui deixaria o cliente voltar ao relógio do navegador em
        // silêncio, que é o defeito que ela existe para fechar. Data fixa para o
        // caso não depender de quando roda.
        hojeNaOrganizacao="2026-09-16"
        googleConfigurado={true}
        faltaNoGoogle={[]}
        tiposIniciais={tipos}
        agendamentosIniciais={[]}
        // #896: a tela passou a exigir quem está logado (o rótulo "Você" é de
        // quem lê). Este teste mede o piso de escrita, que não depende do id.
        usuarioId={usuario}
        orgId={org}
        podeMarcar={podeMarcar}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
  usuario = "u1";
  org = "o1";
});

describe("Agenda no tablet e o aviso do Google", () => {
  it("tablet (matchMedia 1023px): a tela monta em 3 dias", () => {
    montar({ podeMarcar: true });
    expect(screen.getByTestId("grade-da-agenda").getAttribute("data-visao")).toBe("tres");
  });

  it("dispensar o aviso deixa o botão compacto com o mesmo link", () => {
    montar({ podeMarcar: true });
    expect(screen.queryByTestId("conectar-google-compacto")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dispensar"));
    const compacto = screen.getByTestId("conectar-google-compacto");
    expect(compacto.getAttribute("href")).toBe("/api/v1/agenda/google/connect");
  });

  it("o dispensado vale por org e usuário: outro usuário ainda vê o aviso", () => {
    const primeira = montar({ podeMarcar: true });
    fireEvent.click(screen.getByLabelText("Dispensar"));
    primeira.unmount();
    usuario = "u2";
    montar({ podeMarcar: true });
    expect(screen.getByTestId("conectar-google")).toBeTruthy();
    expect(screen.queryByTestId("conectar-google-compacto")).toBeNull();
  });
});
