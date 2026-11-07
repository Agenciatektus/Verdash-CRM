/**
 * Um pedido da Nuvemshop = UM card no funil "Pedidos do Site"; o MESMO card anda de etapa
 * conforme o status do pedido (fatia 4.3). Só age em org que tem o funil com as 6 etapas
 * por slug; sem contato no pedido não há card (nunca cria contato).
 *
 * Vínculo card↔pedido: `crm_leads.source='nuvemshop'` + `external_id=<id do pedido>`
 * (índice único `uniq_crm_leads_org_source_external`), então criar é idempotente.
 * Só avança (posição da etapa maior que a atual): cancelado/refunded é a última etapa e fica.
 * `requestId` com prefixo `rule:` é o anti-laço do motor (não reprocessa os eventos derivados).
 * shortcut: não detecta card movido à mão por um humano para trás (o lead não guarda quem moveu;
 * `last_change_actor_kind` é da etapa); upgrade = guardar a última etapa posta em `custom_fields`.
 * LGPD: nada do comprador entra aqui nem em log; o título leva só o número do pedido.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ORIGEM_PEDIDO_DA_LOJA } from "@/lib/leads/criacao-em-lote";
import type { PedidoRow } from "./pedido-mapper";
import { FUNIL_DE_PEDIDOS, SLUGS, funisCompativeis } from "./funil-de-pedidos";

export { FUNIL_DE_PEDIDOS };

const ETAPA_DO_STATUS: Record<PedidoRow["status"], string> = {
  pending: "aguardando-pagamento",
  paid: "pago-separando",
  shipped: "enviado-ou-pronto-para-retirar",
  fulfilled: "enviado-ou-pronto-para-retirar",
  delivered: "entregue",
  cancelled: "cancelado-ou-com-problema",
  refunded: "cancelado-ou-com-problema",
};

/** Texto da timeline: só o número do pedido e o rastreio da transportadora, nunca dado do comprador. */
function motivoDoEvento(p: { status: PedidoRow["status"]; numero: string | null; externalId: string; rastreio: string | null }): string {
  const n = `Pedido #${p.numero ?? p.externalId}`;
  switch (p.status) {
    case "pending":
      return `${n} criado na loja, aguardando pagamento`;
    case "paid":
      return `${n} pago`;
    case "shipped":
    case "fulfilled":
      return p.rastreio ? `${n} enviado (rastreio ${p.rastreio})` : `${n} enviado`;
    case "delivered":
      return `${n} entregue`;
    case "cancelled":
      return `${n} cancelado`;
    case "refunded":
      return `${n} reembolsado`;
  }
}

export type ResultadoDoCard = { status: "ok" | "skipped"; detail: string };

type Etapa = { id: string; slug: string; position: number; is_archived: boolean; is_won?: boolean; is_lost?: boolean };

async function sincronizar(
  admin: SupabaseClient,
  organizationId: string,
  pedido: {
    externalId: string;
    numero: string | null;
    status: PedidoRow["status"];
    /** Status que o pedido já tinha gravado antes deste evento (null = pedido novo). */
    statusAnterior: PedidoRow["status"] | null;
    totalCents: number | null;
    rastreio: string | null;
    contactId: string | null;
    /** Origem do card (default 'nuvemshop'); o PDV MercadoPhone passa 'mercadophone'. */
    source?: string;
  },
): Promise<ResultadoDoCard> {
  // Funil escolhido na integração (se ainda vale); senão o padrão pelo nome (a Fiorotto depende disso).
  const { data: integ } = await admin
    .from("tenant_integrations")
    .select("store_metadata")
    .eq("organization_id", organizationId)
    .eq("provider", "nuvemshop")
    .maybeSingle();
  const escolhido = (integ as { store_metadata?: { pedidos_pipeline_id?: string } | null } | null)?.store_metadata
    ?.pedidos_pipeline_id;
  let funilId: string | undefined;
  if (escolhido && (await funisCompativeis(admin, organizationId)).some((f) => f.id === escolhido)) {
    funilId = escolhido;
  } else {
    const { data: funis } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("name", FUNIL_DE_PEDIDOS)
      .eq("is_archived", false)
      .order("created_at", { ascending: true })
      .limit(1);
    funilId = (funis as Array<{ id: string }> | null)?.[0]?.id;
  }
  if (!funilId) return { status: "skipped", detail: "funil_ausente" };

  const { data: etapasRaw } = await admin
    .from("crm_stages")
    .select("id, slug, position, is_archived, is_won, is_lost")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", funilId)
    .in("slug", SLUGS);
  const etapas = ((etapasRaw as Etapa[] | null) ?? []).filter((e) => !e.is_archived);
  if (SLUGS.some((s) => !etapas.some((e) => e.slug === s))) {
    return { status: "skipped", detail: "funil_incompleto" };
  }
  if (!pedido.contactId) return { status: "skipped", detail: "sem_contato" };

  // `pedido-novo` fica para quem criar o card à mão: o mapper não distingue "novo" de "aguardando".
  const destino = etapas.find((e) => e.slug === ETAPA_DO_STATUS[pedido.status])!;
  const ctx = {
    organization_id: organizationId,
    actor: { type: "webhook_source", id: "nuvemshop-pedidos" },
    requestId: `rule:nuvemshop-pedidos:${pedido.externalId}`,
  } as HandlerCtx;

  const motivo = motivoDoEvento(pedido);
  // Ganho não tem vocabulário canônico: "Pedido entregue" vale quando o funil não restringe `won_reasons`.
  // Perda exige o canônico (CANONICAL_LOST_REASONS); a causa legível vai em `reason`.
  const entrada = (e: Etapa) => ({
    to_stage_id: e.id,
    reason: motivo,
    ...(e.is_won ? { won_reason: "Pedido entregue" } : {}),
    ...(e.is_lost ? { lost_reason: pedido.status === "cancelled" ? "cancelled_by_store" : "other" } : {}),
  });
  const acha = async () =>
    ((
      await admin
        .from("crm_leads")
        .select("id, stage_id")
        .eq("organization_id", organizationId)
        .eq("source", pedido.source ?? "nuvemshop")
        .eq("external_id", pedido.externalId)
        .maybeSingle()
    ).data as { id: string; stage_id: string } | null) ?? null;
  let atual = await acha();

  if (!atual) {
    // createLeadHandler não aceita lost_reason: o card nasce na etapa aberta anterior e, se o
    // pedido já é terminal (is_won/is_lost), o move abaixo leva à etapa final com o motivo.
    const terminal = !!(destino.is_won || destino.is_lost);
    const nasce = terminal
      ? etapas.find((e) => e.slug === (destino.is_won ? "enviado-ou-pronto-para-retirar" : "aguardando-pagamento"))!
      : destino;
    try {
      const criado = await createLeadHandler(admin as never, ctx, {
        pipeline_id: funilId,
        stage_id: nasce.id,
        title: `Pedido #${pedido.numero ?? pedido.externalId}`,
        contact_id: pedido.contactId,
        value_cents: pedido.totalCents ?? undefined,
        source: pedido.source ?? "nuvemshop",
        external_id: pedido.externalId,
        source_metadata: { evento: motivo },
        // Sem isto o gatilho de follow-up "Lead criado" (que ignora `rule:`) inscreveria o comprador.
        via: ORIGEM_PEDIDO_DA_LOJA,
        tags: [],
      } as Parameters<typeof createLeadHandler>[2]);
      if (!terminal) return { status: "ok", detail: "card_criado" };
      await moveLeadHandler(admin as never, ctx, String(criado.id), entrada(destino));
      return { status: "ok", detail: "card_criado_e_movido" };
    } catch (err) {
      // Corrida: outro evento criou o card entre a leitura e a criação (índice único). Segue para o move.
      atual = await acha();
      if (!atual) throw err;
    }
  }

  // Só reage a MUDANÇA de status do pedido, para não re-avançar a cada order/updated o card que
  // um humano arrastou. shortcut: falha ao mover não é repetida até o status mudar de novo.
  if (pedido.statusAnterior === pedido.status) return { status: "skipped", detail: "sem_mudanca" };
  const posicaoAtual = etapas.find((e) => e.id === atual.stage_id)?.position;
  if (posicaoAtual === undefined) return { status: "skipped", detail: "card_fora_do_funil" };
  if (destino.position <= posicaoAtual) return { status: "skipped", detail: "sem_mudanca" };
  await moveLeadHandler(admin as never, ctx, atual.id, entrada(destino));
  return { status: "ok", detail: "card_movido" };
}

/** Nada aqui derruba nem repete o upsert do pedido: qualquer falha vira `detail`. */
export async function sincronizarCardDoPedido(
  ...args: Parameters<typeof sincronizar>
): Promise<ResultadoDoCard> {
  try {
    return await sincronizar(...args);
  } catch (err) {
    // Só o código curto: a mensagem do erro pode trazer dado do contato.
    return { status: "skipped", detail: `card_falhou:${(err as { code?: string }).code ?? "erro"}` };
  }
}
