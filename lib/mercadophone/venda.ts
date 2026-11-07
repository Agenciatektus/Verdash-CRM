/**
 * Grava a venda do PDV em `orders` ('external' + `mercadophone:<id>`), casa o contato pelo telefone
 * e move o card. Reusável pela rota do webhook e pelo importador. Não loga dado do cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { contatoDoPedido } from "@/lib/nuvemshop/pedido-contato";
import { sincronizarCardDoPedido } from "@/lib/nuvemshop/pedido-card";
import { semRegredir, type PedidoRow } from "@/lib/nuvemshop/pedido-mapper";
import { mapearVenda, telefoneDaVenda } from "./venda-mapper";

type Cru = Record<string, unknown>;
type Atual = Pick<PedidoRow, "status" | "fulfillment_status" | "tracking_code"> & {
  is_anonymized: boolean;
  contact_id: string | null;
};

export async function gravarVenda(
  admin: SupabaseClient,
  organizationId: string,
  cru: Cru,
): Promise<{ status: "ok" | "skipped" | "error"; detail?: string }> {
  const novo = mapearVenda(cru); // lança PedidoInvalidoError sem id/total/data
  const id = String(cru["id"]);
  const chave = { organization_id: organizationId, external_provider: "external", external_id: `mercadophone:${id}` };

  const { data, error: errLeitura } = await admin
    .from("orders")
    .select("status, fulfillment_status, tracking_code, is_anonymized, contact_id")
    .match(chave)
    .maybeSingle();
  if (errLeitura) return { status: "error", detail: `leitura:${errLeitura.code ?? "erro"}` };
  const atual = data as Atual | null;
  if (atual?.is_anonymized) return { status: "skipped", detail: "anonimizado" };

  const cliente = (cru["cliente"] ?? {}) as Cru;
  const casou = atual?.contact_id
    ? null
    : await contatoDoPedido(admin, organizationId, {
        contact_phone: telefoneDaVenda(cru),
        contact_name: cliente["nome"],
      });
  const contactId = atual?.contact_id ?? (casou && "contactId" in casou ? casou.contactId : null);

  const gravado = semRegredir(novo, atual);
  const { error } = await admin
    .from("orders")
    .upsert(
      { ...chave, ...gravado, ...(contactId ? { contact_id: contactId } : {}), updated_at: new Date().toISOString() },
      { onConflict: "organization_id,external_provider,external_id" },
    );
  if (error) return { status: "error", detail: `gravacao:${error.code ?? "erro"}` };

  const card = await sincronizarCardDoPedido(admin, organizationId, {
    externalId: `mercadophone:${id}`,
    numero: id,
    status: gravado.status,
    statusAnterior: atual?.status ?? null,
    totalCents: gravado.total_cents,
    rastreio: null,
    contactId,
    source: "mercadophone",
  });
  return { status: "ok", detail: card.detail };
}
