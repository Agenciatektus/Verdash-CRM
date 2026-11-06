// app/app/campaigns/[id]/edit/_client.test.tsx
/**
 * O AVISO DO TETO NA PRÉVIA DA EDIÇÃO (#2402, #2404).
 *
 * A mesma ponta da tela de criação, com a carga real por trás: o `truncado`
 * de `buscarCandidatos` só protege o operador se a edição — que é onde uma
 * campanha grande é conferida de novo — também mostrar o recibo.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditarCampanha } from "./_client";

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

const salvar = vi.hoisted(() => vi.fn().mockResolvedValue({}));

const lida = vi.hoisted(() => ({ data: undefined as unknown }));

const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const CAMPANHA: Record<string, unknown> = {
  id: "c1",
  name: "Reativação de clientes parados",
  status: "draft",
  channel_session_id: "s1",
  base_legal: "consent",
  lia_ref: null,
  audience_filter: {
    com_alguma_tag: ["vip"],
    limite: 100,
    funis: [U(1)],
    etapas: [U(2)],
    incluir_contatos: [U(3)],
    excluir_contatos: [U(4)],
  },
  message_body: "Oi {{nome}}",
  pipeline_id: null,
  stage_id: null,
  agent_id: null,
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCampanha: () => ({ data: lida.data, isLoading: false }),
  useEditarCampanha: () => ({ mutateAsync: salvar, isPending: false }),
  usePreviaDaAudiencia: () => previa,
  // Número por QR: o formulário mostra o campo de texto, que é o caso deste teste.
  useModelosDaCampanha: () => ({ data: { modo: "text", modelos: [] }, isLoading: false }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [], isLoading: false }),
  channelLabel: (c: { display_name?: string | null }) => c.display_name ?? "Número sem nome",
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [], isLoading: false }),
  useEtapas: () => ({ data: [], isLoading: false }),
  useAgentesPublicados: () => ({ data: [], isLoading: false }),
}));

const FILTRO_PADRAO = { ...(CAMPANHA.audience_filter as Record<string, unknown>) };

// Reset global: um teste que troca a campanha lida ou o filtro não vaza para os outros.
beforeEach(() => {
  salvar.mockClear();
  lida.data = CAMPANHA;
  CAMPANHA.audience_filter = { ...FILTRO_PADRAO };
});

const AVISO = /bateu o teto de 20\.000 negócios desta prévia/;

describe("prévia da edição de campanha: o aviso do teto de 20.000", () => {
  beforeEach(() => {
    previa.data.truncado = false;
    previa.isPending = false;
  });

  it("recorte truncado: a edição mostra o aviso", async () => {
    previa.data.truncado = true;
    render(<EditarCampanha id="c1" />);
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
  });

  it("recorte inteiro: nenhum aviso", async () => {
    render(<EditarCampanha id="c1" />);
    expect(await screen.findByDisplayValue("Reativação de clientes parados")).toBeInTheDocument();
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });

  it("salvar NÃO reenvia funis, etapas, incluir e excluir contatos (o servidor preserva)", async () => {
    render(<EditarCampanha id="c1" />);
    const nome = await screen.findByDisplayValue("Reativação de clientes parados");
    fireEvent.change(nome, { target: { value: "Outro nome" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(salvar).toHaveBeenCalled());
    const enviado = salvar.mock.calls[0]?.[0].audience_filter;
    for (const k of ["funis", "etapas", "incluir_contatos", "excluir_contatos"]) {
      expect(enviado).not.toHaveProperty(k);
    }
    expect(enviado).toMatchObject({ com_alguma_tag: ["vip"], limite: 100 });
  });

  it("limpar a tag na tela manda com_alguma_tag vazio", async () => {
    // sem critério o Salvar não habilita: troca a tag por "sem falar há 30 dias"
    render(<EditarCampanha id="c1" />);
    const tag = await screen.findByDisplayValue("vip");
    fireEvent.change(tag, { target: { value: "" } });
    // outro critério mantém o Salvar habilitado sem a tag
    fireEvent.change(screen.getByLabelText("Sem falar com a gente há (dias)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]?.[0].audience_filter.com_alguma_tag).toEqual([]);
  });

  it("carga tardia (data undefined e depois a campanha): o PATCH leva só o que a tela edita", async () => {
    // só funis/incluídos: nenhum outro estado do memo muda na carga
    lida.data = undefined;
    const { rerender } = render(<EditarCampanha id="c1" />);
    lida.data = {
      ...CAMPANHA,
      entrada_continua: true,
      audience_filter: { limite: 100, funis: [U(1)], incluir_contatos: [U(3)] },
    };
    rerender(<EditarCampanha id="c1" />);
    await screen.findByDisplayValue("Reativação de clientes parados");
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    expect(salvar.mock.calls[0]?.[0].audience_filter).not.toHaveProperty("incluir_contatos");
  });
});

describe("edição: hidratação dos critérios de compra", () => {
  it("filtro antigo, sem os campos novos, abre vazio sem quebrar", async () => {
    render(<EditarCampanha id="c1" />);
    const campos = await screen.findAllByLabelText("Gasto total mínimo (R$)");
    expect(campos[0]).toHaveValue("");
    expect(campos[1]).toHaveValue("");
  });

  it("filtro com excluir preenchido hidrata os campos", async () => {
    CAMPANHA.audience_filter = {
      com_alguma_tag: ["vip"],
      ultima_compra_ha_dias_min: 60,
      gasto_min_centavos: 15000,
      excluir: { ultima_compra_ha_dias_max: 30, compras_min: 2 },
      limite: 100,
    };
    render(<EditarCampanha id="c1" />);
    const min = await screen.findAllByLabelText("Última compra há pelo menos (dias)");
    expect(min[0]).toHaveValue(60);
    expect(screen.getAllByLabelText("Gasto total mínimo (R$)")[0]).toHaveValue("150,00");
    expect(screen.getAllByLabelText("Última compra há no máximo (dias)")[1]).toHaveValue(30);
    expect(screen.getAllByLabelText("Pelo menos N compras")[1]).toHaveValue(2);
  });
});

describe("edição: chave desconhecida no filtro salvo (#405)", () => {
  it("a prévia não leva a chave que o schema não conhece", async () => {
    previa.mutate.mockClear();
    CAMPANHA.audience_filter = { ...FILTRO_PADRAO, chave_removida: true };
    render(<EditarCampanha id="c1" />);
    await screen.findByDisplayValue("Reativação de clientes parados");
    fireEvent.click(screen.getByRole("button", { name: "Ver quantas pessoas" }));
    await waitFor(() => expect(previa.mutate).toHaveBeenCalled());
    const enviado = previa.mutate.mock.calls[0]?.[0].audience_filter;
    expect(enviado).not.toHaveProperty("chave_removida");
    expect(enviado).toMatchObject({ com_alguma_tag: ["vip"] });
  });
});

describe("edição: público só com contatos incluídos ou funis (#403)", () => {
  it("abre com os botões habilitados e lista o que preserva", async () => {
    CAMPANHA.audience_filter = { limite: 100, incluir_contatos: [U(3), U(5)], funis: [U(1)], excluir_contatos: [U(4)] };
    render(<EditarCampanha id="c1" />);
    await screen.findByDisplayValue("Reativação de clientes parados");
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ver quantas pessoas" })).toBeEnabled();
    expect(screen.getByText(/contatos incluídos: 2, funis: 1, excluídos à mão: 1/)).toBeInTheDocument();
  });

  it("só funil (sem contatos) também habilita", async () => {
    CAMPANHA.audience_filter = { limite: 100, funis: [U(1)] };
    render(<EditarCampanha id="c1" />);
    await screen.findByDisplayValue("Reativação de clientes parados");
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
  });

  it("sem critério nenhum segue travado", async () => {
    CAMPANHA.audience_filter = { limite: 100 };
    render(<EditarCampanha id="c1" />);
    await screen.findByDisplayValue("Reativação de clientes parados");
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
  });
});

