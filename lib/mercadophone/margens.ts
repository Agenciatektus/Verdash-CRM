/**
 * Item do HistoricoVendaApiController -> linha de `order_margins` (custo e lucro, só manager+ lê).
 * Nada daqui entra em `orders.payload` nem em ferramenta MCP.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PedidoInvalidoError } from "@/lib/nuvemshop/pedido-mapper";
import { dataDaVenda } from "./venda-mapper";

type Cru = Record<string, unknown>;

export interface MargemRow {
  venda_id: string;
  item_seq: number;
  produto: string | null;
  categoria: string | null;
  quantidade: number | null;
  valor_total_cents: number;
  valor_custo_cents: number;
  lucro_cents: number;
  origem: string | null;
  vendedor: string | null;
  data_venda: string;
  status: string | null;
}

const texto = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Reais -> centavos. Lucro pode ser negativo (brinde); ausente lança em vez de virar 0. */
function cents(v: unknown, campo: string): number {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) throw new PedidoInvalidoError(`${campo}_invalido`);
  return Math.round(n * 100);
}

export function mapearItemDoHistorico(item: Cru, seq: number): MargemRow {
  if (item["vendaId"] == null || item["vendaId"] === "") throw new PedidoInvalidoError("item_sem_vendaId");
  const q = Number(item["quantidade"]);
  return {
    venda_id: String(item["vendaId"]),
    item_seq: seq,
    produto: texto(item["produtoDescricao"]),
    categoria: texto(item["tipoProdutoDescricao"]),
    quantidade: Number.isFinite(q) ? q : null,
    valor_total_cents: cents(item["valorTotal"], "valorTotal"),
    valor_custo_cents: cents(item["valorCusto"], "valorCusto"),
    lucro_cents: cents(item["lucro"], "lucro"),
    origem: texto(item["tipoVendaDescricao"]),
    vendedor: texto(item["vendedorNome"]),
    data_venda: dataDaVenda(item["dataVenda"]),
    status: texto(item["statusVenda"]),
  };
}

/**
 * Grava os itens de uma página. `contador` (vendaId -> próximo seq) vive entre páginas, para a
 * mesma venda não reaproveitar o seq. Liga `order_id` quando a venda já está em `orders`.
 */
export async function gravarMargens(
  admin: SupabaseClient,
  organizationId: string,
  itens: Cru[],
  contador: Map<string, number>,
): Promise<{ gravadas: number; erro?: string }> {
  if (!itens.length) return { gravadas: 0 };
  const linhas = itens.map((it) => {
    const id = String(it["vendaId"]);
    const seq = contador.get(id) ?? 0;
    contador.set(id, seq + 1);
    return mapearItemDoHistorico(it, seq);
  });
  const externos = [...new Set(linhas.map((l) => `mercadophone:${l.venda_id}`))];
  const { data } = await admin
    .from("orders")
    .select("id, external_id")
    .eq("organization_id", organizationId)
    .eq("external_provider", "external")
    .in("external_id", externos);
  const ids = new Map(((data ?? []) as { id: string; external_id: string }[]).map((o) => [o.external_id, o.id]));
  const agora = new Date().toISOString();
  const { error } = await admin.from("order_margins").upsert(
    linhas.map((l) => ({
      ...l,
      organization_id: organizationId,
      order_id: ids.get(`mercadophone:${l.venda_id}`) ?? null,
      updated_at: agora,
    })),
    { onConflict: "organization_id,venda_id,item_seq" },
  );
  return error ? { gravadas: 0, erro: error.code ?? "erro" } : { gravadas: linhas.length };
}
