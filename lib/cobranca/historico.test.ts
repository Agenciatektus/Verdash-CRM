import { describe, expect, it } from "vitest";

import { acoesDoCard, estornavel, ultimoEstorno, type PagamentoDoHistorico } from "./historico";

const pag = (extra: Partial<PagamentoDoHistorico> = {}): PagamentoDoHistorico => ({
  id: "p1", cobranca_ref: "ch_1", valor_cents: 9_900, moeda: "brl", status: "pago", valor_estornado_cents: 0,
  pago_em: "2026-10-01T12:00:00Z", estornado_em: null, url_do_recibo: null, ...extra,
});

describe("estornavel", () => {
  it("pago com cobrança e saldo é estornável", () => expect(estornavel(pag())).toBe(true));
  it("parcial com saldo ainda é", () => expect(estornavel(pag({ status: "estornado_parcial", valor_estornado_cents: 1_000 }))).toBe(true));
  it.each([
    ["estornado todo", { status: "estornado" as const, valor_estornado_cents: 9_900 }],
    ["contestado", { status: "contestado" as const }],
    ["sem cobrança no provedor", { cobranca_ref: null }],
  ])("%s não é", (_c, extra) => expect(estornavel(pag(extra))).toBe(false));
});

describe("ultimoEstorno", () => {
  it("sem estorno → null (controle negativo)", () => expect(ultimoEstorno([pag(), pag({ id: "p2" })])).toBeNull());
  it("pega o de estornado_em mais recente", () => {
    const velho = pag({ id: "a", valor_estornado_cents: 100, estornado_em: "2026-10-02T00:00:00Z" });
    const novo = pag({ id: "b", valor_estornado_cents: 200, estornado_em: "2026-10-05T00:00:00Z" });
    expect(ultimoEstorno([novo, velho, pag({ id: "c" })])?.id).toBe("b");
    expect(ultimoEstorno([velho, novo])?.id).toBe("b");
  });
});

describe("acoesDoCard", () => {
  const ativaNoProvedor = { estado: "ativa" as const, provedor: "stripe" };
  it("isenta: nenhuma ação de provedor", () => {
    expect(acoesDoCard(null, [pag()])).toEqual({ cancelada: false, podeGerarLink: false, podeCancelar: false, podeEstornar: false });
  });
  it("cancelada: sem cancelar e sem link, mas estorna se houver pagamento estornável", () => {
    const a = acoesDoCard({ estado: "cancelada", provedor: "stripe" }, [pag()]);
    expect(a).toEqual({ cancelada: true, podeGerarLink: false, podeCancelar: false, podeEstornar: true });
  });
  it("cancelada com tudo estornado: nada a fazer no provedor", () => {
    const a = acoesDoCard({ estado: "cancelada", provedor: "stripe" }, [pag({ status: "estornado", valor_estornado_cents: 9_900 })]);
    expect(a.podeEstornar).toBe(false);
  });
  it("ativa no provedor: cancela, não gera link", () => {
    const a = acoesDoCard(ativaNoProvedor, [pag()]);
    expect(a).toMatchObject({ cancelada: false, podeCancelar: true, podeGerarLink: false });
  });
  it("em atraso gera link; em teste sem provedor não cancela nem estorna", () => {
    expect(acoesDoCard({ estado: "em_atraso", provedor: "asaas" }, []).podeGerarLink).toBe(true);
    expect(acoesDoCard({ estado: "trial", provedor: null }, [])).toMatchObject({ podeCancelar: false, podeEstornar: false, podeGerarLink: true });
  });
  it("histórico vazio mantém Estornar (ainda não relido)", () => expect(acoesDoCard(ativaNoProvedor, []).podeEstornar).toBe(true));
});
