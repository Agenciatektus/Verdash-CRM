import { describe, expect, it } from "vitest";
import amostras from "../../fixtures/mercadophone/amostras.json";
import { mapearItemDoHistorico } from "@/lib/mercadophone/margens";

const item = () => structuredClone(amostras.item_HistoricoVendaApiController) as Record<string, unknown>;

describe("mapearItemDoHistorico", () => {
  it("mapeia custo, lucro, origem e data de Brasília em UTC", () => {
    const r = mapearItemDoHistorico(item(), 0);
    expect(r).toMatchObject({
      venda_id: "8039221", item_seq: 0, categoria: "Celular", origem: "Trafego Pago", vendedor: "RAYANE",
      valor_total_cents: 410000, valor_custo_cents: 375000, lucro_cents: 35000, status: "concluido",
      data_venda: "2026-09-28T18:20:00.000Z",
    });
  });

  it("brinde: total 0, custo e lucro negativo entram como vierem", () => {
    const r = mapearItemDoHistorico(structuredClone(amostras.item_brinde[0]) as Record<string, unknown>, 1);
    expect([r.valor_total_cents, r.valor_custo_cents, r.lucro_cents]).toEqual([0, 300, -300]);
  });

  it("cancelado mantém o status", () => {
    expect(mapearItemDoHistorico(structuredClone(amostras.item_cancelado[0]) as Record<string, unknown>, 0).status).toBe("cancelada");
  });

  it.each(["valorCusto", "lucro", "valorTotal", "dataVenda", "vendaId"])("controle negativo: sem %s lança", (campo) => {
    const x = item();
    x[`${campo}_renomeado`] = x[campo];
    delete x[campo];
    expect(() => mapearItemDoHistorico(x, 0)).toThrow();
  });
});
