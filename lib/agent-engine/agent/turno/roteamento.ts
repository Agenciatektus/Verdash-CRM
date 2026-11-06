/**
 * F3 do turno da IA: roteamento e configuração do agente (ADR-0006, fatia S4).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Resolve o agente (roteador, ou o já
 * resolvido/preview), desvia o assistido para o rascunho, para no pausado, grava a
 * decisão do roteador (uma por job, #3143) e aplica o destino do card pela
 * intenção. A prévia com assunto comercial restrito para aqui (#2877). O horário
 * do agente e a contagem da condução foram para `desvios-deterministicos.ts`
 * (v1.90: depois das detecções e do filtro de palavra-chave). As paradas voltam
 * como `Passo`: só o orquestrador faz o `return`.
 */
import { setExecutionAgentOperation, currentExecutionBoundary } from '@/lib/atendimento/fronteira-server';
import { contemAssuntoComercialRestrito } from '@/lib/escalacao/assunto-comercial';

import { resolveConversationTurn, type TurnAgentResolution } from '../resolve-turn-agent';
import type { TurnPreview } from '../preview';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import {
  decisaoDeRoteamentoDoJobJaGravada,
  deteccoesDeterministicasDoAssistido,
  inboundsNaoRespondidos,
} from '../inbound-turn';
import type { ContextoDoTurno, Passo } from './portoes-de-entrada';

import { aplicarDestinoDoCardDaIntencao } from './destino-do-card';

export interface SaidaDoRoteamento {
  routed:
    | TurnAgentResolution
    | { config: TurnPreview['agent']; routerId: null; intentName: null; confidence: null; outcome: string };
  agentConfig: TurnAgentResolution['config'] | TurnPreview['agent'];
  agentOperation: Parameters<typeof setExecutionAgentOperation>[0] | undefined;
}

export async function resolverRoteamentoDoTurno(
  c: ContextoDoTurno,
  e: { restricaoComercial: boolean },
): Promise<Passo<SaidaDoRoteamento>> {
  const { deps, job, pool, input, preview, tenantId, leadId, runLog, liveJob } = c;

  // A prévia faz a mesma passagem do handler (`escalarComercialAntesDoModelo`), mas
  // só PROPÕE: nada é enviado nem silenciado no Testar. O turno real já passou por
  // ela antes de escolher o agente (#2877).
  if (
    preview &&
    e.restricaoComercial &&
    inboundsNaoRespondidos(preview.context.context.messages).some(contemAssuntoComercialRestrito)
  ) {
    preview.result.proposals.push({ tool: 'crm_request_human_handoff', arguments: {
      reason: 'Valores e negociação: atendimento exclusivamente humano.',
    } });
    preview.result.impediments.push({ code: 'commercial_requires_human',
      message: 'Valores e negociação: a IA não pode responder. Atendimento humano necessário.' });
    runLog.info('assunto comercial restrito: prévia propõe a passagem sem chamar o redator');
    return { seguir: false, motivo: 'previa_comercial_restrito' };
  }

  const routed = preview
    ? { config: preview.agent, routerId: null, intentName: null, confidence: null, outcome: 'preview' }
    : input.resolvedAgent ?? await resolveConversationTurn(pool, deps.llmCfg, {
        tenantId, leadId, jobId: liveJob().id,
        channelSessionId: input.channelSessionId,
        conversationId: input.conversationId,
        inbound: liveJob().kind === 'inbound_turn',
      }, { log: runLog, jev: deps.jev });
  const agentConfig = routed.config;
  // O traço grava o agente que o turno RESOLVEU: follow-up e resposta de caso
  // não passam `resolvedAgent`, e sem isto a linha ficaria sem agente nem fontes.
  if (input.tracoDoTurno !== undefined) input.tracoDoTurno.desfecho.config = agentConfig;
  if (!preview && input.conducao && agentConfig?.operationMode === 'assisted') {
    // Defensivo: o handler só manda condução AUTOMÁTICA para cá com agente
    // automático. Rascunho aqui sairia sem a condução — não gera nada.
    runLog.warn('condução automática com agente assistido — turno não executado', {
      conducao_id: input.conducao.id,
    });
    return { seguir: false, motivo: 'conducao_com_agente_assistido' };
  }
  // #2155 — o destino do card. `in` porque o ramo de preview/campanha devolve um
  // objeto literal SEM estes campos: sem a guarda, o tipo da união recusa a leitura.
  const destinoPipelineId = 'destinationPipelineId' in routed ? (routed.destinationPipelineId ?? null) : null;
  const destinoStageId = 'destinationStageId' in routed ? (routed.destinationStageId ?? null) : null;
  if (
    !preview &&
    agentConfig?.operationMode === 'assisted' &&
    job !== null &&
    (job.kind === 'inbound_turn' || job.kind === 'followup_turn')
  ) {
    // #1648 — as detecções DETERMINÍSTICAS (STOP/opt-out e pedido de humano)
    // rodam ANTES do desvio para o rascunho. Elas não gastam token e não
    // dependem do modo de operação, e o pedido de parar não pode esperar
    // aprovação humana para ser registrado (LGPD). `true` = turno silenciado
    // (aviso já enviado, silêncio durável e crons cancelados): aí não há
    // rascunho o que rascunhar.
    if (
      await deteccoesDeterministicasDoAssistido(pool, deps, {
        job,
        tenantId,
        conversationId: input.conversationId,
        channelSessionId: input.channelSessionId,
        leadId,
        agent: agentConfig,
        log: runLog,
        ...(input.inboundMessageId !== undefined
          ? { inboundMessageId: input.inboundMessageId }
          : {}),
      })
    ) {
      return { seguir: false, motivo: 'assistido_silenciado_pelas_deteccoes' };
    }
    const { generateReplyDraft } = await import('../reply-drafts');
    await generateReplyDraft(pool, deps, {
      organizationId: tenantId,
      conversationId: input.conversationId,
      contactId: leadId,
      channelId: input.channelSessionId,
      boundary: currentExecutionBoundary() ?? undefined,
      agent: agentConfig,
    });
    if (job.kind === 'followup_turn') {
      // #1648 (3): o follow-up do assistido caía no `return` genérico de baixo
      // e sumia — sem envio, sem rascunho e sem aviso. Vira rascunho, como o
      // inbound: o humano vê, edita, aprova ou rejeita.
      runLog.info('follow-up de agente assistido virou rascunho — nada sai sem aprovação', {
        conversation_id: input.conversationId,
      });
    }
    return { seguir: false, motivo: 'assistido_virou_rascunho' };
  }
  if (!preview && agentConfig && (agentConfig.pausedAt || agentConfig.operationMode === 'assisted'))
    return { seguir: false, motivo: 'agente_pausado_ou_assistido' };
  const agentOperation =
    !preview && agentConfig?.operationRevision
      ? {
          organizationId: tenantId,
          agentId: agentConfig.agentId,
          versionId: agentConfig.versionId,
          revision: agentConfig.operationRevision,
        }
      : undefined;
  if (agentOperation) setExecutionAgentOperation(agentOperation);
  if (agentConfig !== null) {
    runLog.info('config do agente publicada em uso', {
      agent_id: agentConfig.agentId,
      agent_version_id: agentConfig.versionId,
      model: agentConfig.model,
      router_outcome: routed.outcome,
      intent: routed.intentName,
    });
  }
  // O horário de funcionamento do agente e a contagem da condução moram em
  // `desvios-deterministicos.ts` desde a v1.90 (#2679): rodam DEPOIS das
  // detecções determinísticas e do filtro de palavra-chave.

  // Fase 3: grava a decisão de roteamento e a aderência da conversa ao agente.
  // Fire-and-forget — falha de telemetria nunca derruba a resposta ao lead.
  //
  // #3143 — UM TURNO, UMA DECISÃO DE ROTEAMENTO. O turno adiado pela JANELA DO
  // AGENTE (o gate em `desvios-deterministicos.ts`, depois do filtro de
  // palavra-chave) volta como a MESMA linha de `job_queue` (`rescheduleJob`), e a
  // reexecução resolve o turno outra vez. A decisão da PRIMEIRA passagem é
  // REUSADA: não grava de novo nem reaplica o destino do card. A guarda é de
  // TELEMETRIA e degrada ABERTO: se a leitura falhar, grava como antes.
  let decisaoJaGravada = false;
  if (!preview && routed.routerId !== null) {
    try {
      decisaoJaGravada = await decisaoDeRoteamentoDoJobJaGravada(
        pool,
        tenantId,
        liveJob().id,
        liveJob().created_at,
      );
    } catch (err) {
      runLog.warn('não consegui conferir a decisão de roteamento deste job — gravando como antes', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
    try {
      if (agentConfig !== null) {
        await pool.query(
          `update conversations
           set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
           where organization_id = $1 and id = $2`,
          [tenantId, input.conversationId, agentConfig.agentId, routed.intentName],
        );
      }
      // A intenção e a confiança que ROTEARAM — do classificador, ou do Jev
      // quando a tarefa do roteador dele decide (`resolve-turn-agent.ts`). Quem
      // decidiu mora em `llm_calls` do mesmo `job_id` (purpose `intent_router`,
      // `origem_da_escolha = 'jev'`); o único leitor desta tabela
      // (`app/api/v1/ai/evolution`) conta roteamento, não quem o fez.
      if (!decisaoJaGravada) {
        await pool.query(
          `insert into ai_router_decisions
             (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            tenantId,
            routed.routerId,
            input.conversationId,
            routed.intentName,
            routed.confidence,
            agentConfig?.agentId ?? null,
            routed.outcome,
            liveJob().id,
          ],
        );
      }
    } catch (err) {
      runLog.warn('decisão do router não gravada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }
  // No turno reexecutado depois do adiamento pela janela do agente o destino NÃO
  // é reaplicado: a passagem anterior já moveu o card (#3143).
  if (!decisaoJaGravada) await aplicarDestinoDoCardDaIntencao(c, { destinoPipelineId, destinoStageId, routed, agentConfig });
  return { seguir: true, valor: { routed, agentConfig, agentOperation } };
}
