// app/app/campaigns/new/_client.test.tsx
/**
 * O AVISO DO TETO NA PRÉVIA (#2402, #2404).
 *
 * `buscarCandidatos` devolve `truncado` quando o recorte bate o teto de 20.000
 * linhas de negócio; a tela é o ÚNICO lugar onde esse recibo vira informação
 * para o operador. Sem este teste o campo viaja do banco até aqui sem ninguém
 * conferir a última ponta — e a prévia volta a cortar calada.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NovaCampanha } from "./_client";

const previa = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
  data: {
    total: 20_001,
    elegiveis: 500,
    excluidos: 0,
    motivos: {} as Record<string, number>,
    truncado: false,
    amostra: [] as Array<{ nome: string | null; motivo: string | null }>,
    legenda: {} as Record<string, string>,
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCriarCampanha: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePreviaDaAudiencia: () => previa,
  // Número por QR: o formulário mostra o campo de texto, que é o caso deste teste.
  useModelosDaCampanha: () => ({ data: { modo: "text", modelos: [] }, isLoading: false }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [], isLoading: false }),
  channelLabel: (c: { display_name?: string | null }) => c.display_name ?? "Número sem nome",
}));
// Os padrões de envio da instalação (ritmo, janela): sem eles a tela usa os do
// código, e aqui o assunto é só o aviso do teto.
vi.mock("@/hooks/campanhas/useConfiguracao", () => ({
  useConfiguracaoDeCampanhas: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [], isLoading: false }),
  useEtapas: () => ({ data: [], isLoading: false }),
  useAgentesPublicados: () => ({ data: [], isLoading: false }),
}));

const AVISO = /bateu o teto de 20\.000 negócios desta prévia/;

describe("prévia da nova campanha: o aviso do teto de 20.000", () => {
  beforeEach(() => {
    previa.data.truncado = false;
    previa.isPending = false;
  });

  it("recorte truncado: o operador VÊ o aviso na prévia", () => {
    previa.data.truncado = true;
    render(<NovaCampanha />);
    expect(screen.getByText(AVISO)).toBeInTheDocument();
  });

  it("recorte inteiro: nenhum aviso — o campo não vira ruído", () => {
    render(<NovaCampanha />);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});

describe("nova campanha: critérios de compra no filtro", () => {
  function preencher(rotulo: string | RegExp, valor: string, indice = 0) {
    fireEvent.change(screen.getAllByLabelText(rotulo)[indice]!, { target: { value: valor } });
  }
  function filtroEnviado() {
    fireEvent.click(screen.getByRole("button", { name: "Ver quantas pessoas" }));
    return previa.mutate.mock.calls.at(-1)![0].audience_filter;
  }

  beforeEach(() => previa.mutate.mockClear());

  it("há pelo menos 60 + excluir há no máximo 30 chegam no payload", () => {
    render(<NovaCampanha />);
    preencher("Última compra há pelo menos (dias)", "60", 0);
    preencher("Última compra há no máximo (dias)", "30", 1);
    const f = filtroEnviado();
    expect(f.ultima_compra_ha_dias_min).toBe(60);
    expect(f.excluir.ultima_compra_ha_dias_max).toBe(30);
  });

  it("gasto 150,00 vira 15000 centavos; bloco excluir vazio manda null", () => {
    render(<NovaCampanha />);
    preencher("Gasto total mínimo (R$)", "150,00", 0);
    const f = filtroEnviado();
    expect(f.gasto_min_centavos).toBe(15000);
    expect(f.excluir).toBeNull();
  });

  it("sem nenhum critério, 'Ver quantas pessoas' fica desligado; com um campo de compra, liga", () => {
    render(<NovaCampanha />);
    const botao = screen.getByRole("button", { name: "Ver quantas pessoas" });
    expect(botao).toBeDisabled();
    preencher("Gasto total mínimo (R$)", "10", 0);
    expect(botao).toBeEnabled();
  });
});
