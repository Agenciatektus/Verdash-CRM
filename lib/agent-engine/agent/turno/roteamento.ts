/**
 * F3 do turno da IA: roteamento e configuração do agente (ADR-0006, fatia S4).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Resolve o agente (roteador, ou o já
 * resolvido/preview), desvia o assistido para o rascunho, para no pausado, adia
 * fora do horário de atendimento (o aviso sai antes; `JobSettledError` é lançado
 * aqui mesmo, como antes), conta o turno da condução, grava a decisão do roteador
 * e aplica o destino do card pela intenção. As paradas voltam como `Passo`: só o
 * orquestrador faz o `return`.
 */
import { setExecutionAgentOperation, currentExecutionBoundary } from '@/lib/atendimento/fronteira-server';
import { MAX_TURNOS_POR_CONDUCAO } from '@/lib/cadencia/conducao/settings';
import { contarTurno, encerrarConducaoEPassarParaHumano } from '@/lib/cadencia/conducao/turno';

import { claimOfJob } from '../../queue/claim';
import { rescheduleJob } from '../../queue/queue';
import { msAteAJanelaAbrir } from '../janela-de-atendimento';
import { enviaAvisoForaDoHorario, portasDeProducao } from '../aviso-fora-do-horario';
import { resolveConversationTurn, type TurnAgentResolution } from '../resolve-turn-agent';
import type { TurnPreview } from '../preview';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import {
  JobSettledError,
  avisoAoLeadDoTurno,
  deteccoesDeterministicasDoAssistido,
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
): Promise<Passo<SaidaDoRoteamento>> {
  const { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;

  const routed = preview
    ? { config: preview.agent, routerId: null, intentName: null, confidence: null, outcome: 'preview' }
    : input.resolvedAgent ?? await resolveConversationTurn(pool, deps.llmCfg, {
        tenantId, leadId, jobId: liveJob().id,
        channelSessionId: input.channelSessionId,
        conversationId: input.conversationId,
        inbound: liveJob().kind === 'inbound_turn',
      }, { log: runLog, jev: deps.jev });
  const agentConfig = routed.config;
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
  // Horário de funcionamento da versão publicada (spec da tela: TriggerEditor).
  // Vale SÓ para o turno inbound: a janela do lojista é sobre QUANDO ele atende
  // quem chega, e adiar por ela um follow-up já prometido ao lead atrasaria uma
  // promessa que não é dele. O que segura o follow-up é a janela anti-ban logo
  // acima (`pacing/engine.ts`), que vale para os dois.
  //
  // Adia, não descarta: o job volta a 'pending' na abertura, SEM consumir
  // attempts (`rescheduleJob`) — quem escreveu 22h é atendido às 8h. O throw é
  // o contrato de `JobSettledError`: o run já dispôs do job, main.ts no-opa.
  if (!preview && liveJob().kind === 'inbound_turn' && agentConfig?.janelaDeAtendimento != null) {
    const esperaMs = msAteAJanelaAbrir(agentConfig.janelaDeAtendimento, clock());
    if (esperaMs !== null) {
      // O AVISO DE FORA DO HORÁRIO (#1926) — ANTES do adiamento, para sair na
      // hora em que a mensagem chegou. É resposta a quem escreveu primeiro (o
      // pacing lê a janela `resposta*` e o aviso CONTA no ledger); as réguas de
      // opt-out, teto de envio e LGPD continuam valendo — a ordem e os vetores
      // moram em `aviso-fora-do-horario.ts`. Qualquer erro aqui só PERDE um
      // aviso: o turno é adiado de qualquer forma, e a resposta não pode morrer
      // por causa de um recado.
      try {
        const aviso = await enviaAvisoForaDoHorario(
          portasDeProducao(pool, deps.crmCfg.supabase, runLog),
          {
            organizationId: tenantId,
            conversationId: input.conversationId,
            contactId: leadId,
            channelSessionId: input.channelSessionId,
            texto: agentConfig.avisoForaDoHorario ?? null,
            janela: agentConfig.janelaDeAtendimento,
            agora: clock(),
          },
        );
        runLog.info(
          aviso.enviar
            ? 'aviso de fora do horário enviado'
            : 'aviso de fora do horário não enviado',
          { motivo: aviso.enviar ? 'enviado' : aviso.motivo },
        );
      } catch (err) {
        runLog.warn('aviso de fora do horário falhou — o turno segue adiado para a abertura', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
      await rescheduleJob(pool, liveJob().id, ctx.workerId, {
        acquiredAt: claimOfJob(liveJob())?.acquired_at,
        delayMs: esperaMs,
        reason:
          'fora do horário de funcionamento do agente — turno adiado para a abertura da janela',
      });
      runLog.info(
        'turno adiado — fora do horário de funcionamento configurado na versão publicada',
        {
          agent_id: agentConfig.agentId,
          espera_ms: esperaMs,
          janela: `${agentConfig.janelaDeAtendimento.start}-${agentConfig.janelaDeAtendimento.end}`,
        },
      );
      throw new JobSettledError(
        'fora do horário de funcionamento — job reagendado para a abertura da janela',
      );
    }
  }

  // CONDUÇÃO DA CADÊNCIA: cada turno conta. Depois dos adiamentos (janela
  // anti-ban e horário do agente), para o job reagendado não contar duas vezes.
  // Passou do teto, a IA para e uma pessoa assume.
  if (!preview && input.conducao) {
    const turnos = await contarTurno(pool, tenantId, input.conducao.id);
    if (turnos === null) {
      runLog.info('condução da cadência encerrada no meio-tempo — turno não executado', {
        conducao_id: input.conducao.id,
      });
      return { seguir: false, motivo: 'conducao_encerrada' };
    }
    if (turnos > MAX_TURNOS_POR_CONDUCAO) {
      await encerrarConducaoEPassarParaHumano(
        pool,
        input.conducao,
        'teto_de_turnos',
        runLog,
        avisoAoLeadDoTurno(deps, pool, liveJob(), input.channelSessionId, input.conversationId, runLog),
      );
      return { seguir: false, motivo: 'conducao_no_teto_de_turnos' };
    }
  }

  // Fase 3: grava a decisão de roteamento e a aderência da conversa ao agente.
  // Fire-and-forget — falha de telemetria nunca derruba a resposta ao lead.
  if (!preview && routed.routerId !== null) {
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
    } catch (err) {
      runLog.warn('decisão do router não gravada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }
  await aplicarDestinoDoCardDaIntencao(c, { destinoPipelineId, destinoStageId, routed, agentConfig });
  return { seguir: true, valor: { routed, agentConfig, agentOperation } };
}
