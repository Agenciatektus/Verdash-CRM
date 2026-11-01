/**
 * LEVAR O NEGÓCIO PARA OUTRO FUNIL MOVE O MESMO CARD (decisão do Peterson,
 * 19/10/2026). Nunca clona e nunca abre negócio novo: o `crm_leads.id` é o mesmo,
 * e conversa, atividades, linha do tempo, etiquetas e campos vão junto.
 *
 * O caso típico: ganho no funil de vendas, levado ao funil de pós-venda ou de
 * recompra. O funil de ORIGEM continua contando a venda (ganho, valor, perda)
 * depois que o card sai, pelo retrato gravado em `crm_lead_passagens_de_funil`
 * (migration 9053) e lido por `crm_desfechos_de_negocio`.
 *
 * Um caminho só para a rota (`POST /api/v1/leads/[id]/clone`, nome mantido pelo
 * contrato) e para a automação `create_or_move_lead`: duas implementações de
 * "trocar de funil" divergiriam na primeira mudança de uma delas.
 *
 * O que NÃO acontece aqui, de propósito: nada reescreve won→lost, nenhum
 * `lead.won`/`lead.lost` (conversão Meta/Google/CAPI) sai de novo, nenhum
 * `lead.created` (a cadência de lead novo) e nenhum `lead.stage_changed` — salvo
 * quando quem move pede "rodar as automações de entrada da etapa"
 * (`rodarAutomacoesDeEntrada`, padrão desligado; ver `entrada-pela-troca.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { emiteEntradaNaEtapa } from "@/lib/leads/entrada-pela-troca";
import { RECUSA_DO_LEAD_UNICO, ehViolacaoDoLeadUnico } from "@/lib/leads/negocio-aberto-duplicado";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  escolheEtapaDeDestino,
  recusaTrocaDeFunil,
  type EtapaDoFunil,
} from "@/lib/leads/clonar-para-funil";
import { rpc } from "@/lib/supabase/rpc";

/** As colunas do negócio que a troca lê antes de mover. */
export interface NegocioParaMover {
  id: string;
  pipeline_id: string;
  stage_id?: string | null;
  status: string;
  contact_id?: string | null;
  custom_fields?: Record<string, unknown> | null;
  value_cents?: number | null;
}

export type ResultadoDaTroca =
  | { ok: true; lead: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      code: string;
      /** Já traduzida quando é a recusa de campos; senão, pt-BR para `traduzir`. */
      texto: string;
      details?: Record<string, unknown>;
    };

const STATUS_LEGIVEL: Record<string, string> = { won: "ganho", lost: "perdido", open: "aberto" };

/** A frase da linha do tempo: de onde saiu, como estava, para onde foi. */
export function razaoDaPassagem(entrada: {
  deFunil: string | null;
  paraFunil: string | null;
  status: string;
}): string {
  const de = entrada.deFunil ? `do funil ${entrada.deFunil}` : "de outro funil";
  const para = entrada.paraFunil ? `no funil ${entrada.paraFunil}` : "em outro funil";
  const como = STATUS_LEGIVEL[entrada.status] ?? entrada.status;
  return `Saiu ${de} (${como}) e entrou ${para}`;
}

/** O erro do banco (RAISE da 9053, índice da 9082) na recusa de negócio equivalente. */
function recusaDoBanco(erro: { code?: string; message: string }): ResultadoDaTroca | null {
  const mensagem = erro.message;
  // O contato já tem negócio aberto no funil de destino.
  if (ehViolacaoDoLeadUnico(erro)) {
    return { ok: false, status: 409, code: RECUSA_DO_LEAD_UNICO.codigo, texto: RECUSA_DO_LEAD_UNICO.mensagem };
  }
  if (mensagem.includes("pipeline_unchanged")) {
    return { ok: false, status: 422, code: "pipeline_unchanged", texto: "O negócio já está neste funil. Para trocar de etapa use /api/v1/leads/[id]/move." };
  }
  if (mensagem.includes("stage_pipeline_mismatch")) {
    return { ok: false, status: 422, code: "stage_pipeline_mismatch", texto: "A etapa não pertence ao funil de destino." };
  }
  if (mensagem.includes("lead_not_found")) {
    return { ok: false, status: 404, code: "not_found", texto: "Lead não encontrado." };
  }
  return null;
}

/**
 * Move o negócio para `pipelineId` (na etapa `stageId`, ou na primeira etapa
 * aberta do destino). Vale para negócio aberto E encerrado.
 *
 * As recusas vêm antes da escrita, e a escrita é UMA transação
 * (`fn_mover_lead_de_funil`): retrato da saída + UPDATE do mesmo card.
 */
export async function moverNegocioDeFunil(
  db: SupabaseClient,
  ctx: HandlerCtx,
  negocio: NegocioParaMover,
  destino: {
    pipelineId: string;
    stageId?: string | null;
    origemDaChamada: string;
    /** Padrão desligado: só com `true` a entrada na etapa de destino dispara automações. */
    rodarAutomacoesDeEntrada?: boolean;
  },
): Promise<ResultadoDaTroca> {
  const recusa = recusaTrocaDeFunil(negocio, destino.pipelineId);
  if (recusa) return { ok: false, status: recusa.status, code: recusa.code, texto: recusa.texto };

  const [funis, etapasLidas] = await Promise.all([
    db
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", ctx.organization_id)
      .in("id", [negocio.pipeline_id, destino.pipelineId]),
    db
      .from("crm_stages")
      .select("id, pipeline_id, position, is_won, is_lost, is_archived")
      .eq("organization_id", ctx.organization_id)
      .eq("pipeline_id", destino.pipelineId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
  ]);
  if (funis.error) return { ok: false, status: 500, code: "internal_error", texto: funis.error.message };
  if (etapasLidas.error) {
    return { ok: false, status: 500, code: "internal_error", texto: etapasLidas.error.message };
  }
  const nomes = new Map(
    ((funis.data ?? []) as { id: string; name: string | null }[]).map((f) => [f.id, f.name]),
  );
  if (!nomes.has(destino.pipelineId)) {
    return { ok: false, status: 404, code: "pipeline_not_found", texto: FUNIL_DE_DESTINO_NAO_ENCONTRADO };
  }

  const etapa = escolheEtapaDeDestino((etapasLidas.data ?? []) as EtapaDoFunil[], destino.stageId ?? null);
  if (!etapa.ok) return { ok: false, status: etapa.status, code: etapa.code, texto: etapa.texto };

  // Entrar na etapa de destino é o mesmo gatilho do arrasto: o funil que exige um
  // campo para receber o negócio o exige aqui também, antes da escrita.
  const veredito = validaCamposExigidos({
    lead: { custom_fields: negocio.custom_fields ?? {} },
    settingsDoFunil: await settingsDoFunil(db, destino.pipelineId),
    destino: { stageId: etapa.etapa.id, desfecho: null },
    motivoDeGanho: null,
  });
  if (veredito.faltando.length > 0) {
    const r = recusaDeCamposObrigatorios(veredito.faltando, ctx.idioma);
    return { ok: false, status: 422, code: r.codigo, texto: r.mensagem, details: { faltando: veredito.faltando } };
  }

  const ator = ctx.actor.type === "user" ? ctx.actor.id : null;
  const { data: movido, error } = await rpc(db, "fn_mover_lead_de_funil", {
    p_org: ctx.organization_id,
    p_lead: negocio.id,
    p_pipeline: destino.pipelineId,
    p_stage: etapa.etapa.id,
    p_ator: ator,
  });
  if (error) {
    return recusaDoBanco(error) ?? { ok: false, status: 500, code: "internal_error", texto: error.message };
  }
  const lead = movido as unknown as Record<string, unknown>;

  const payload = {
    from_pipeline_id: negocio.pipeline_id,
    from_stage_id: negocio.stage_id ?? null,
    from_status: negocio.status,
    from_value_cents: negocio.value_cents ?? null,
    to_pipeline_id: destino.pipelineId,
    to_stage_id: etapa.etapa.id,
  };
  const atividade = await emitLeadActivity(db, {
    organizationId: ctx.organization_id,
    leadId: negocio.id,
    contactId: negocio.contact_id ?? null,
    type: "moved_from_pipeline",
    sourceModule: "crm",
    sourceId: negocio.id,
    actor: ctx.actor,
    reason: razaoDaPassagem({
      deFunil: nomes.get(negocio.pipeline_id) ?? null,
      paraFunil: nomes.get(destino.pipelineId) ?? null,
      status: negocio.status,
    }),
    payload,
  });
  if (!atividade.ok) {
    // Falha BAIXO: o card já mudou, e prender a troca à timeline a deixaria refém
    // do registro. Contada, nunca engolida.
    await registraFalhaDeAtividade(db, {
      organizationId: ctx.organization_id,
      leadId: negocio.id,
      tipo: "moved_from_pipeline",
      origem: destino.origemDaChamada,
      erro: atividade.error,
      requestId: ctx.requestId,
    });
  }

  await audit({
    action: "lead.moved_to_pipeline",
    actorUserId: ator,
    organizationId: ctx.organization_id,
    resourceType: "crm_lead",
    resourceId: negocio.id,
    requestId: ctx.requestId,
    metadata: { actor_type: ctx.actor.type, ...payload },
  });

  if (destino.rodarAutomacoesDeEntrada === true) {
    await emiteEntradaNaEtapa(db, {
      organizationId: ctx.organization_id,
      leadId: negocio.id,
      deFunil: negocio.pipeline_id,
      deEtapa: negocio.stage_id ?? null,
      paraFunil: destino.pipelineId,
      paraEtapa: etapa.etapa.id,
      status: String(lead?.status ?? negocio.status),
      actor: ctx.actor,
      requestId: ctx.requestId,
    });
  }

  return { ok: true, lead };
}
