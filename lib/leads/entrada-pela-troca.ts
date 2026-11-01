/**
 * "RODAR AS AUTOMAÇÕES DE ENTRADA DA ETAPA" ao levar o card para outro funil
 * (decisão do Peterson, 19/10/2026). Padrão DESLIGADO.
 *
 * A troca de funil (`mover-de-funil.ts`) não emite `lead.stage_changed` de
 * propósito. Com a opção ligada, depois do move sai UM `lead.stage_changed` para
 * a etapa de destino, o MESMO evento do arrasto no quadro: regras de automação,
 * follow-up de etapa e campanha contínua reagem como se o card tivesse acabado de
 * entrar ali. Reaproveita o caminho que já existe, sem motor novo.
 *
 * O que NÃO sai por esta opção: conversão (Meta/Google/CAPI). Os dois
 * consumidores de conversão leem a marca abaixo e pulam (`ehEntradaPelaTroca`).
 *
 * Idempotência: o evento só sai DEPOIS de `fn_mover_lead_de_funil` gravar, e o
 * banco recusa a segunda troca para o mesmo funil (`pipeline_unchanged`, sob
 * `for update`). Duplo clique move uma vez e emite uma vez.
 *
 * Anti-laço: a entrada pedida por uma regra leva `troca_por_regra`. Uma regra
 * que rodou por causa DESSA entrada não emite outra (`entradaEncadeada`): no
 * máximo um salto, A→B→A não gira.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { rpc } from "@/lib/supabase/rpc";

export const MARCA_DA_ENTRADA = "entrada_pela_troca_de_funil";

type Metadata = Record<string, unknown> | null | undefined;

/** O evento é a entrada pedida pela troca de funil? (conversões pulam) */
export function ehEntradaPelaTroca(metadata: Metadata): boolean {
  return metadata?.[MARCA_DA_ENTRADA] === true;
}

/** O evento é uma entrada que uma REGRA pediu? Então a regra seguinte não encadeia outra. */
export function entradaEncadeada(metadata: Metadata): boolean {
  return ehEntradaPelaTroca(metadata) && typeof metadata?.troca_por_regra === "string";
}

export async function emiteEntradaNaEtapa(
  db: SupabaseClient,
  a: {
    organizationId: string;
    leadId: string;
    deFunil: string;
    deEtapa: string | null;
    paraFunil: string;
    paraEtapa: string;
    status: string;
    actor: { type: string; id: string };
    requestId: string;
  },
): Promise<void> {
  const regra = a.actor.type === "webhook_source" ? a.actor.id : null;
  // `service_origin` fica de fora: `emit_event` carimba a origem de
  // `lead.stage_changed` no servidor (0279), como no arrasto.
  const { error } = await rpc(db, "emit_event", {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: a.leadId,
    p_payload: {
      pipeline_id: a.paraFunil,
      from_pipeline_id: a.deFunil,
      from_stage_id: a.deEtapa,
      to_stage_id: a.paraEtapa,
      status: a.status,
    },
    // `request_id` sem o prefixo `rule:` de propósito: com ele o motor pularia
    // o evento (profundidade 1) e a opção não faria nada na automação. O laço
    // é contido por `troca_por_regra` (ver o cabeçalho).
    p_metadata: {
      request_id: regra ? `troca:${regra}` : a.requestId,
      [MARCA_DA_ENTRADA]: true,
      ...(regra ? { troca_por_regra: regra } : { actor_user_id: a.actor.id }),
    },
    p_organization_id: a.organizationId,
  });
  if (error) {
    logger.error("[entrada-pela-troca] emit_event lead.stage_changed falhou", {
      lead_id: a.leadId,
      organization_id: a.organizationId,
      error: error.message,
    });
  }
}
