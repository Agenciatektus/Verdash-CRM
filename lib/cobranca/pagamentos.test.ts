import { describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, valorDoFiltro, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

import type { AdaptadorDeCobranca, PagamentoLido } from "@/lib/cobranca/provedores/contrato";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { gravarPagamentos, marcarEstorno, statusDoPagamento } from "./pagamentos";

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";

function lido(p: Partial<PagamentoLido> = {}): PagamentoLido {
  return {
    pagamentoRef: "in_1", cobrancaRef: "ch_1", valorCents: 9_900, moeda: "brl", estornadoCents: 0, contestado: false,
    pagoEm: new Date("2026-10-01T12:00:00Z"), estornadoEm: null, planoId: null, urlDoRecibo: null, ...p,
  };
}

/**
 * Tabela em memória com a regra do banco: único em (provedor, pagamento_ref).
 * Upsert sem `onConflict` nessa chave é INSERT para o PostgREST (conflito no id),
 * e a 2ª gravação da mesma fatura bate no único: 23505, como no banco real.
 */
function tabela() {
  const linhas = new Map<string, Record<string, unknown>>();
  const chave = (l: Record<string, unknown>) => `${String(l.provedor)}|${String(l.pagamento_ref)}`;
  const responder = (c: Cadeia): Resposta => {
    if (c.tabela !== "cobranca_pagamentos") return { error: { code: "42P01", message: "tabela inesperada" } };
    if (operacao(c) === "upsert") {
      const [novas, opcoes] = argumentos(c, "upsert") as [Record<string, unknown>[], { onConflict?: string } | undefined];
      for (const l of novas) {
        if (opcoes?.onConflict !== "provedor,pagamento_ref" && linhas.has(chave(l))) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        linhas.set(chave(l), { ...linhas.get(chave(l)), ...l });
      }
      return { data: null };
    }
    if (operacao(c) === "update") {
      const campos = argumentos(c, "update")?.[0] as Record<string, unknown>;
      const alvo = [...linhas.values()].filter(
        (l) =>
          l.organization_id === valorDoFiltro(c, "eq", "organization_id") &&
          l.provedor === valorDoFiltro(c, "eq", "provedor") &&
          l.cobranca_ref === valorDoFiltro(c, "eq", "cobranca_ref") &&
          l.status !== valorDoFiltro(c, "neq", "status"),
      );
      for (const l of alvo) Object.assign(l, campos);
      return { data: alvo.map(() => ({ id: "x" })) };
    }
    return { data: [...linhas.values()] };
  };
  return { linhas, banco: bancoFalso(responder) };
}

const adaptadorCom = (listar: AdaptadorDeCobranca["listarPagamentos"]) => ({ listarPagamentos: listar }) as unknown as AdaptadorDeCobranca;

describe("statusDoPagamento", () => {
  it("pago, parcial, total e contestado (disputa vence o estorno)", () => {
    expect(statusDoPagamento(100, 0, false)).toBe("pago");
    expect(statusDoPagamento(100, 40, false)).toBe("estornado_parcial");
    expect(statusDoPagamento(100, 100, false)).toBe("estornado");
    expect(statusDoPagamento(100, 100, true)).toBe("contestado");
  });
});

describe("gravarPagamentos", () => {
  it("reler duas vezes não duplica: uma linha por (provedor, pagamento_ref), e o estorno relido vira status", async () => {
    const t = tabela();
    const listar = vi.fn<NonNullable<AdaptadorDeCobranca["listarPagamentos"]>>().mockResolvedValueOnce([lido()]);
    listar.mockResolvedValueOnce([lido({ estornadoCents: 9_900, estornadoEm: new Date("2026-10-02T00:00:00Z") })]);
    expect(await gravarPagamentos(t.banco.cliente as never, ORG, "stripe", adaptadorCom(listar), "cus_1")).toBe(1);
    expect(await gravarPagamentos(t.banco.cliente as never, ORG, "stripe", adaptadorCom(listar), "cus_1")).toBe(1);
    expect(t.linhas.size).toBe(1);
    expect([...t.linhas.values()][0]).toMatchObject({
      organization_id: ORG, provedor: "stripe", pagamento_ref: "in_1", cobranca_ref: "ch_1", status: "estornado",
      valor_estornado_cents: 9_900, estornado_em: "2026-10-02T00:00:00.000Z",
    });
  });

  it("controle negativo: o dublê recusa a 2ª gravação de quem faz upsert sem a chave única (o teste acima mede algo)", async () => {
    const t = tabela();
    const semChave = async () =>
      (await (t.banco.cliente.from("cobranca_pagamentos").upsert as (l: unknown[]) => PromiseLike<unknown>)([
        { provedor: "stripe", pagamento_ref: "in_1" },
      ])) as { error: { code?: string } | null };
    expect((await semChave()).error).toBeNull();
    expect((await semChave()).error?.code).toBe("23505");
  });

  it("falha do provedor ou da gravação: devolve null e não lança", async () => {
    const t = tabela();
    const quebra = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await gravarPagamentos(t.banco.cliente as never, ORG, "stripe", adaptadorCom(quebra), "cus_1")).toBeNull();
    const semTabela = bancoFalso(() => ({ error: { code: "42P01", message: "relation does not exist" } }));
    const ok = vi.fn().mockResolvedValue([lido()]);
    expect(await gravarPagamentos(semTabela.cliente as never, ORG, "stripe", adaptadorCom(ok), "cus_1")).toBeNull();
  });

  it("provedor sem listarPagamentos (Asaas): 0, sem tocar o banco", async () => {
    const t = tabela();
    expect(await gravarPagamentos(t.banco.cliente as never, ORG, "asaas", {} as AdaptadorDeCobranca, "cus_1")).toBe(0);
    expect(t.banco.cadeias).toEqual([]);
  });
});

describe("marcarEstorno", () => {
  it("grava status e valor estornado na linha da cobrança; contestado não é sobrescrito", async () => {
    const t = tabela();
    await gravarPagamentos(t.banco.cliente as never, ORG, "stripe", adaptadorCom(async () => [lido(), lido({ pagamentoRef: "in_2", cobrancaRef: "ch_2", contestado: true })]), "cus_1");
    const agora = new Date("2026-10-05T00:00:00Z");
    expect(await marcarEstorno(t.banco.cliente as never, { orgId: ORG, provedor: "stripe", cobrancaRef: "ch_1", valorCents: 9_900, estornadoCents: 4_000, agora })).toBe(true);
    expect(t.linhas.get("stripe|in_1")).toMatchObject({ status: "estornado_parcial", valor_estornado_cents: 4_000, estornado_em: agora.toISOString() });
    expect(await marcarEstorno(t.banco.cliente as never, { orgId: ORG, provedor: "stripe", cobrancaRef: "ch_2", valorCents: 9_900, estornadoCents: 9_900, agora })).toBe(false);
    expect(t.linhas.get("stripe|in_2")).toMatchObject({ status: "contestado" });
  });
});
