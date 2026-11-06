/**
 * Venda do MercadoPhone (webhook `venda_salva` ou VendaApiController) -> linha de `orders`. Função pura.
 * `payload` é lista fixa: sem custo, lucro nem dado pessoal (LGPD). Venda de balcão = `delivered`.
 */
import { PedidoInvalidoError, type PedidoRow } from "@/lib/nuvemshop/pedido-mapper";

type Cru = Record<string, unknown>;

export const vendaCancelada = (cru: Cru) => String(cru["status"] ?? "").toLowerCase().includes("cancel");

const texto = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Reais (número ou texto) -> centavos, arredondando para fugir do float (1739.9 * 100). */
function centavos(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new PedidoInvalidoError("total_invalido");
  return Math.round(n * 100);
}

/** "2026-11-02 11:41:00" em Brasília (-03:00) -> ISO UTC. */
function dataDaVenda(v: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(v ?? ""));
  const hora = m?.[2]?.length === 5 ? `${m[2]}:00` : m?.[2];
  const t = m ? Date.parse(`${m[1]}T${hora}-03:00`) : NaN;
  if (Number.isNaN(t)) throw new PedidoInvalidoError("dataVenda_invalida");
  return new Date(t).toISOString();
}

export function telefoneDaVenda(cru: Cru): unknown {
  return (cru["cliente"] as Cru | undefined)?.["telefone"];
}

export function mapearVenda(cru: Cru): PedidoRow {
  if (cru["id"] == null || cru["id"] === "") throw new PedidoInvalidoError("venda_sem_id");
  const formas = Array.isArray(cru["formasPagamento"]) ? (cru["formasPagamento"] as Cru[]) : [];
  const itens = Array.isArray(cru["itens"]) ? (cru["itens"] as Cru[]) : [];
  return {
    status: vendaCancelada(cru) ? "cancelled" : "delivered",
    fulfillment_status: null,
    tracking_code: null,
    total_cents: centavos(cru["totalVenda"]),
    currency: "BRL",
    payment_method: texto(formas[0]?.["formaPagamentoDescrita"]),
    ordered_at: dataDaVenda(cru["dataVenda"]),
    updated_at_remote: null,
    customer_external_id: cru["clienteId"] != null ? String(cru["clienteId"]) : null,
    payload: {
      platform: "mercadophone",
      venda_id: cru["id"],
      tipoVendaDescricao: cru["tipoVendaDescricao"] ?? null,
      tipoEntregaDescricao: cru["tipoEntregaDescricao"] ?? null,
      vendedorNome: cru["vendedorNome"] ?? null,
      itens: itens.map((i) => ({
        produtoId: i["produtoId"] ?? null,
        produtoNome: i["produtoNome"] ?? null,
        quantidade: i["quantidade"] ?? null,
        valorTotal: i["valorTotal"] ?? null,
      })),
    },
  };
}
