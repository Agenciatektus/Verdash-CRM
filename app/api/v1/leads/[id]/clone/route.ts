import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/clone — levar o negócio para OUTRO funil.
 *
 * ⚠️ O nome ficou pelo contrato (a UI, a recusa 422 `pipeline_immutable_use_clone`
 * do `/move` e quem integra pela API apontam para cá), mas desde a migration 9053
 * a rota NÃO clona: MOVE O MESMO CARD (decisão do Peterson, 19/10/2026). O
 * `crm_leads.id` não muda, o histórico vai junto e o funil de origem segue
 * contando o desfecho daquela passagem (`crm_lead_passagens_de_funil`). Vale para
 * negócio aberto e encerrado. A lógica mora em `lib/leads/mover-de-funil.ts`,
 * a mesma da automação `create_or_move_lead`.
 *
 * Contrato desde a 9053: 200 (antes 201), `data.lead` é o MESMO negócio (mesmo
 * `id` do path, agora no funil de destino) e `data.origem` repete o mesmo objeto
 * para cliente antigo que o lia. `lost_reason` é aceito e ignorado: a origem não
 * fecha mais como perdida.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { moverNegocioDeFunil, type NegocioParaMover } from "@/lib/leads/mover-de-funil";
import { cloneLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * A etapa como a tela de destino precisa dela: `id`/`name` para o seletor e os
 * três campos que dizem se ela pode RECEBER o negócio. `is_archived` fica de
 * fora porque o filtro é do banco (`.eq("is_archived", false)`): etapa arquivada
 * não é escolha, nem como explicação.
 */
interface EtapaDeDestino {
  id: string;
  pipeline_id: string;
  name: string;
  /** `numeric` no Postgres chega como string pelo PostgREST. */
  position: number | string;
  is_won: boolean;
  is_lost: boolean;
}

/** O que a tela recebe: sem `pipeline_id`, que já é a chave do funil na resposta. */
type EtapaNaResposta = Omit<EtapaDeDestino, "pipeline_id">;

/**
 * GET /api/v1/leads/[id]/clone — para ONDE este negócio pode ir.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (pipelines read = manager+,
 * `GET /api/v1/pipelines`): quem vai clicar em "Levar para outro funil" precisa
 * escolher o destino, e `pipeline.move_card` (a MESMA permissão que já autoriza
 * o POST abaixo) já é `agent`+ — negar a leitura aqui só empurraria o mesmo dado
 * por um caminho sem gate nenhum. Payload mínimo: `id` e `name`, nunca
 * `settings`/`description` (isso é configuração, fica atrás de `manager` na rota
 * de gestão). O funil ATUAL do lead sai da lista — não é destino válido de troca
 * (a mesma regra de `recusaTrocaDeFunil`, medida aqui em vez de deixar a tela
 * descobrir só ao tentar).
 *
 * ── Por que as ETAPAS vêm junto (issue #3643) ────────────────────────────────
 *
 * O diálogo passou a pedir também a etapa de entrada, e a lista dela NÃO pode
 * vir de `GET /api/v1/pipelines/:id/stages`: aquela rota é `manager`+ (é a tela
 * de configuração do funil) e quem leva o card é `agent`. Com duas fontes, o
 * vendedor veria o seletor de funil e nenhuma etapa — exatamente o operador que
 * a issue quer atender. Aqui a leitura é a mesma de `id`/`name`: o nome da
 * coluna já aparece para qualquer papel no quadro, e `position`/`is_won`/
 * `is_lost` são o que a tela precisa para oferecer só etapa ABERTA (a mesma
 * régua de `escolheEtapaDeDestino`, que continua sendo quem decide no POST).
 * Uma chamada por abertura do diálogo, não uma por funil escolhido.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data: origem, error: selErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const { pipelines } = await listPipelinesHandler(supabase, {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
  });

  const idsDosDestinos = pipelines
    .filter((p) => p.id !== (origem as { pipeline_id: string }).pipeline_id)
    .map((p) => p.id);

  // Funil único (instalação nova) não é erro: a tela explica que não há destino.
  // Sem esta guarda o `.in("pipeline_id", [])` iria ao banco pedir nada.
  const { data: etapas, error: stagesErr } =
    idsDosDestinos.length === 0
      ? { data: [] as EtapaDeDestino[], error: null }
      : await supabase
          .from("crm_stages")
          .select("id, pipeline_id, name, position, is_won, is_lost")
          .eq("organization_id", authz.org.orgId)
          .in("pipeline_id", idsDosDestinos)
          .eq("is_archived", false)
          .order("position", { ascending: true });

  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });

  const etapasPorFunil = new Map<string, EtapaNaResposta[]>();
  for (const etapa of (etapas ?? []) as EtapaDeDestino[]) {
    const lista = etapasPorFunil.get(etapa.pipeline_id) ?? [];
    lista.push({
      id: etapa.id,
      name: etapa.name,
      position: etapa.position,
      is_won: etapa.is_won,
      is_lost: etapa.is_lost,
    });
    etapasPorFunil.set(etapa.pipeline_id, lista);
  }

  const destinos = pipelines
    .filter((p) => p.id !== (origem as { pipeline_id: string }).pipeline_id)
    .map((p) => ({ id: p.id, name: p.name, stages: etapasPorFunil.get(p.id) ?? [] }));

  return ok({ pipelines: destinos }, { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const handlerCtx: HandlerCtx = {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  try {
    const input = await validateRequest(cloneLeadSchema, req);

    // Filtro por organização explícito como defesa em profundidade: a RLS já
    // recorta o client do usuário.
    const { data: negocio, error: selErr } = await supabase
      .from("crm_leads")
      .select("id, pipeline_id, stage_id, status, contact_id, custom_fields, value_cents")
      .eq("id", leadId)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();
    if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
    if (!negocio) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

    const troca = await moverNegocioDeFunil(supabase, handlerCtx, negocio as NegocioParaMover, {
      pipelineId: input.pipeline_id,
      stageId: input.stage_id ?? null,
      origemDaChamada: "app/api/v1/leads/[id]/clone",
      rodarAutomacoesDeEntrada: input.rodar_automacoes_de_entrada === true,
    });
    if (!troca.ok) {
      return fail(troca.code, t(troca.texto), troca.status, {
        ...(troca.details ? { details: troca.details } : {}),
        requestId,
      });
    }

    return ok({ lead: troca.lead, origem: troca.lead }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
