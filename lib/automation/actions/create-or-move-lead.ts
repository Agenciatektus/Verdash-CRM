import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `create_or_move_lead` — reusa os handlers core de /api/v1/leads
 * (mesmo caminho que REST/MCP) em vez de duplicar a lógica de criação/move.
 *
 * Actor = `webhook_source` com id = ruleId (ator automático; audit registra
 * actor_type=webhook_source). requestId = `rule:${ruleId}` — os handlers
 * propagam esse valor pro metadata.request_id dos eventos que emitem, e é
 * esse prefixo "rule:" que o engine (Task 8) usa pra não reprocessar os
 * eventos derivados (anti-loop profundidade 1: regra→ação→handler→evento).
 */
import { getAction, registerAction } from "@/lib/automation/actions";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { viaHerdada } from "@/lib/leads/criacao-em-lote";
import { moverNegocioDeFunil, type NegocioParaMover } from "@/lib/leads/mover-de-funil";
import { entradaEncadeada } from "@/lib/leads/entrada-pela-troca";
import { negocioAbertoDoContato } from "@/lib/leads/negocio-aberto-do-contato";

/**
 * "Criar card novo" (`modo: "criar"`): o card em outro funil fica onde está e
 * nasce um card NOVO no destino — o caminho de `create_lead_in_pipeline`, pelo
 * registro (sem import circular entre as duas ações). Sem `modo`, esta ação MOVE,
 * como desde a 9053.
 */
async function criaCardNovo(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const criar = getAction("create_lead_in_pipeline");
  if (!criar) return { type: "create_or_move_lead", status: "failed", error: "unknown_action" };
  const r = await criar.execute(ctx, { ...config, modo: "criar" });
  return { ...r, type: "create_or_move_lead" };
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  const stageId = typeof config.stage_id === "string" ? config.stage_id : null;
  if (!pipelineId || !stageId) {
    return { type: "create_or_move_lead", status: "failed", error: "missing_config" };
  }
  const criarNovo = config.modo === "criar";
  // Uma regra que rodou POR CAUSA de uma entrada pedida por outra regra não
  // encadeia outra entrada (anti-laço, `lib/leads/entrada-pela-troca.ts`).
  const rodarAutomacoesDeEntrada =
    config.rodar_automacoes_de_entrada === true && !entradaEncadeada(ctx.event?.metadata);

  const handlerCtx: HandlerCtx = {
    organization_id: ctx.organizationId,
    actor: { type: "webhook_source", id: ctx.ruleId },
    requestId: `rule:${ctx.ruleId}`,
  };
  // A LINHA INTEIRA do negócio, como `buildContext` a lê (`select *` de
  // `crm_leads`): o ramo abaixo precisa de `title`, `tags`, `custom_fields` e
  // companhia quando o caminho é a transferência (#2155).
  const lead = ctx.context.lead as (NegocioParaMover & { contact_id?: string | null }) | undefined;
  const contact = ctx.context.contact as
    | { id: string; name?: string | null; display_name?: string | null; phone_number?: string | null }
    | undefined;

  // `?? undefined` porque `contact_id` admite `null` (a linha
  // do banco) e `publicaNoContexto` aceita `string | undefined`.
  const contactId = contact?.id ?? lead?.contact_id ?? undefined;
  handlerCtx.serviceOrigin = contactId
    ? (await originFromAutomationEvent(ctx, contactId)) ?? { kind: "unavailable", reason: "origin_capture_failed" }
    : { kind: "unavailable", reason: "origin_capture_failed" };

  try {
    if (lead) {
      if (lead.pipeline_id !== pipelineId) {
        if (criarNovo) return criaCardNovo(ctx, config);
        // Outro funil: MOVE o mesmo card (9053), como a rota da tela.
        const negocio = await leDoBanco(ctx, lead.id);
        if (!negocio) return { type: "create_or_move_lead", status: "failed", error: "not_found" };
        const troca = await moverNegocioDeFunil(ctx.admin, handlerCtx, negocio, {
          pipelineId,
          stageId,
          origemDaChamada: "lib/automation/actions/create-or-move-lead",
          rodarAutomacoesDeEntrada,
        });
        if (!troca.ok) return { type: "create_or_move_lead", status: "failed", error: troca.code };
        publicaNoContexto(ctx, troca.lead, contactId);
        return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id, pipeline_id: pipelineId } };
      }

      // ── lead.won NO MESMO FUNIL: A AÇÃO NÃO MOVE (#1528 + #2769) ────────────
      //
      // Com a porta de `lead.won` aberta para `create_or_move_lead`, este ramo
      // (mesmo funil) volta a ser alcançável — e é EXATAMENTE o que a #1528
      // vetou: mover o negócio recém-ganho para uma etapa aberta o REABRE,
      // `lead.stage_changed` sai do reabrir, uma regra de etapa o leva de volta
      // para a etapa de ganho, e as duas se realimentam sem fim.
      //
      // Então `lead.won` só tem uma moda aqui: levar o MESMO card a outro funil
      // (o ramo acima, 9053; no fork nada é clonado). O mesmo funil não é continuação — é reescrever o
      // ganho —, e a recusa diz isso com uma frase própria na aba Atividade.
      if (ctx.event?.event_type === "lead.won") {
        return {
          type: "create_or_move_lead",
          status: "failed",
          error: "continuacao_exige_outro_funil",
        };
      }
      const movido = await moveLeadHandler(ctx.admin, handlerCtx, lead.id, { to_stage_id: stageId });
      publicaNoContexto(ctx, movido, contactId);
      return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id } };
    }
    if (contact) {
      // Gatilho de CONTATO não traz lead no contexto (`lib/automation/engine.ts`),
      // e sem isto a ação chamada de "criar/mover" só sabia criar: o contato
      // ganhava um negócio novo a cada vez que a regra rodava (#958). O negócio
      // procurado é o ABERTO no funil de destino — negócio de outro funil segue
      // fora, pela mesma regra que recusa mover entre funis.
      const existente = await negocioAbertoDoContato(ctx.admin, ctx.organizationId, contact.id, pipelineId);
      if (existente) {
        const movido = await moveLeadHandler(ctx.admin, handlerCtx, existente.id, { to_stage_id: stageId });
        publicaNoContexto(ctx, movido, contact.id);
        return { type: "create_or_move_lead", status: "success", detail: { moved: existente.id } };
      }

      // ── O CONTATO COM NEGÓCIO ABERTO EM OUTRO FUNIL: A REGRA O MOVE ─────────
      //
      // Sem esta leitura o contato com negócio aberto no funil A ganhava um
      // SEGUNDO negócio no funil B (#992). Desde a 9053 a troca move o MESMO card
      // (sem clone e sem a perda "Levado para outro funil"), pelo mesmo caminho
      // da rota da tela (`lib/leads/mover-de-funil.ts`).
      const emOutroFunil = await negocioAbertoEmOutroFunil(ctx, contact.id, pipelineId);
      if (emOutroFunil && criarNovo) return criaCardNovo(ctx, config);
      if (emOutroFunil) {
        const troca = await moverNegocioDeFunil(ctx.admin, handlerCtx, emOutroFunil, {
          pipelineId,
          stageId,
          origemDaChamada: "lib/automation/actions/create-or-move-lead",
          rodarAutomacoesDeEntrada,
        });
        if (!troca.ok) return { type: "create_or_move_lead", status: "failed", error: troca.code };
        publicaNoContexto(ctx, troca.lead, contact.id);
        return {
          type: "create_or_move_lead",
          status: "success",
          detail: { moved: emOutroFunil.id, pipeline_id: pipelineId },
        };
      }
      const created = await createLeadHandler(ctx.admin, handlerCtx, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        // O título nasce do MESMO resolvedor das telas. Remontado à mão, ele
        // gravava `Contato 543134@lid` no card do funil — e título de lead
        // não se reescreve sozinho depois.
        title: nomeDoContato(contact) ?? contact.phone_number ?? "Lead da automação",
        contact_id: contact.id,
        source: "automation",
        // A MARCA DE LOTE do evento de origem viaja com o card que esta ação
        // cria. Sem ela, a cadeia dava a volta: a campanha cria 500 cards em
        // lote, o motor pula as ações que FALAM, roda esta — e os 500
        // `lead.created` novos saem sem marca, com `requestId = 'rule:…'` que o
        // gatilho de follow-up não olha. Resultado: 500 mensagens proativas no
        // mesmo minuto da abordagem, pelo salto seguinte da cadeia.
        ...viaHerdada(ctx.event.metadata),
      } as Parameters<typeof createLeadHandler>[2]);
      publicaNoContexto(ctx, created, contact.id);
      // Corrida com outro escritor (9082): o card aberto já existia.
      if (created.reaproveitado) {
        return { type: "create_or_move_lead", status: "success", detail: { reaproveitado: String(created.id) } };
      }
      return { type: "create_or_move_lead", status: "success", detail: { created: String(created.id) } };
    }
    return { type: "create_or_move_lead", status: "skipped", detail: { reason: "no_lead_or_contact" } };
  } catch (err) {
    return {
      type: "create_or_move_lead",
      status: "failed",
      error: mensagemDeErro(err),
    };
  }
}

/**
/** As colunas que a troca de funil lê antes de mover. */
const COLUNAS_DA_TROCA = "id, pipeline_id, stage_id, status, contact_id, custom_fields, value_cents";

async function leDoBanco(ctx: ActionCtx, leadId: string): Promise<NegocioParaMover | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select(COLUNAS_DA_TROCA)
    .eq("organization_id", ctx.organizationId)
    .eq("id", leadId)
    .maybeSingle();
  return (data as NegocioParaMover | null) ?? null;
}

/**
 * O negócio ABERTO do contato em qualquer OUTRO funil, se houver um.
 *
 * É o caso que a #992 mediu: o contato tem negócio aberto no funil A, a regra
 * aponta para o funil B, e sem esta leitura a ação criava um segundo negócio em
 * B em vez de levar o de A. O mais recente primeiro — o mesmo desempate de
 * `negocioAbertoDoContato`, e o mesmo comportamento quando a leitura falha
 * (`null`: a ação cria, como criava antes).
 */
async function negocioAbertoEmOutroFunil(
  ctx: ActionCtx,
  contactId: string,
  pipelineId: string,
): Promise<NegocioParaMover | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select(COLUNAS_DA_TROCA)
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .neq("pipeline_id", pipelineId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as NegocioParaMover | null) ?? null;
}

/**
 * As ações seguintes da MESMA regra passam a enxergar o lead.
 *
 * `assign_owner` lê `ctx.context.lead` e, num gatilho de contato, devolvia
 * `skipped: missing_input` mesmo depois de esta ação ter criado o negócio —
 * a execução inteira aparecia como "Parcial" na aba Atividade (#958). As
 * condições da regra já foram avaliadas quando isto roda (`engine.ts` filtra
 * `applicable` antes do laço), então escrever aqui não muda o que casou.
 */
function publicaNoContexto(ctx: ActionCtx, row: Record<string, unknown>, contactId?: string): void {
  // A LINHA INTEIRA, mesclada com o que já havia no contexto — nunca um objeto
  // com três campos. `add_tag` lê `ctx.context.lead.tags` como "as tags do
  // banco" e grava `[...prev, ...added]`: com um objeto parcial, `prev` é `[]`
  // e o UPDATE APAGA as tags existentes do negócio, inclusive a de anúncio que
  // `lib/leads/nascimento-do-lead.ts` grava. `call_webhook` projeta o mesmo
  // objeto sobre LEAD_PUBLIC_FIELDS, então o corpo entregue ao endpoint do
  // cliente encolheria em silêncio pelo mesmo motivo.
  const anterior = (ctx.context.lead ?? {}) as Record<string, unknown>;
  ctx.context.lead = {
    ...anterior,
    ...row,
    contact_id: row.contact_id ?? contactId ?? anterior.contact_id ?? null,
  };
}

registerAction({ type: "create_or_move_lead", execute });
