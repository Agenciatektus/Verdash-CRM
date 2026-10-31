/**
 * F11 do turno da IA: correções depois do modelo (ADR-0006, fatia S9).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: a correção limitada do turno mudo (2ª
 * chamada de modelo), a falha terminal visível do silêncio sem razão legítima (caso
 * humano) e a pergunta garantida do roteiro. Devolve a fita das chamadas do turno.
 */
import { claimOfJob } from '../../queue/claim';
import { runModelCall, type ModelMessage, type ToolSet } from '../../edge/llm/run-model-call';
import { runBeforeSend } from '../../guardrails/before-send';
import { hasOpenCaseForContact, openCase } from '../human-cases';
import { eTurnoDeResposta } from '../inbound-turn';
import { garantirPerguntaDoRoteiro, perguntaDoRoteiroPodeSair } from '../roteiro-no-turno';
import { CORRECAO_DO_TURNO_MUDO, turnoMudoPedeCorrecao } from '../turno-mudo';
import type { chamarOModelo } from './chamada-do-modelo';
import type { carregarContextoDoTurno } from './contexto';
import type { SaidaDosDesvios } from './desvios-deterministicos';
import type { EstadoDoTurno } from './estado-do-turno';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { prepararContextoDoTurno } from './preparo-do-contexto';
import type { SaidaDoRoteamento } from './roteamento';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;
type SaidaDaChamada = Awaited<ReturnType<typeof chamarOModelo>>;

export interface EntradaDaCorrecao {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  agentOperation: SaidaDoRoteamento['agentOperation'];
  system: SaidaDoContexto['system'];
  maxSteps: SaidaDoContexto['maxSteps'];
  openingMessages: ModelMessage[];
  tools: ToolSet;
  turn: SaidaDaChamada['turn'];
  saidaTruncada: boolean;
  roteiro: Awaited<ReturnType<typeof prepararContextoDoTurno>>['roteiro'];
  liveChannel: SaidaDosDesvios['liveChannel'];
  optedOutThisTurn: SaidaDosDesvios['optedOutThisTurn'];
  lgpd: SaidaDosDesvios['lgpd'];
  maxSendsPerTurn: number;
  capDeEnvioAtingido: () => boolean;
  buildCaseContextSnapshot: () => Record<string, unknown>;
  moverParaHandoffBestEffort: (reason: string) => void;
  pararDigitando: () => void;
}

export async function corrigirAposOModelo(c: ContextoDoTurno, r: EntradaDaCorrecao, estado: EstadoDoTurno) {
  const { deps, job, pool, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const {
    agentConfig, agentOperation, system, maxSteps, openingMessages, tools, turn, saidaTruncada, roteiro, liveChannel,
    optedOutThisTurn, lgpd, maxSendsPerTurn, capDeEnvioAtingido, buildCaseContextSnapshot, moverParaHandoffBestEffort,
    pararDigitando,
  } = r;

  // TURNO MUDO: o turno de resposta terminou sem mensagem ao cliente e sem
  // nenhuma razão para o silêncio (`turno-mudo.ts`). UMA correção, com a mesma
  // conversa e as mesmas ferramentas: o envio passa pela cadeia inteira, como
  // qualquer outro. O fechamento lê a fita das DUAS chamadas.
  let mensagensDoTurno: ModelMessage[] = turn.result.responseMessages;
  // Foi PEDIDA (e logo abaixo EXECUTADA) a correção limitada do turno mudo? O
  // valor é consumido DEPOIS dela, no desfecho terminal, junto com
  // `correcaoTruncou` (o sinal de FALHA da própria correção): correção que
  // terminou truncada (length) é defeito, mas silêncio DELIBERADO — que o
  // CORRECAO_DO_TURNO_MUDO autoriza o modelo a escolher — nunca abre caso.
  // Erro da chamada de correção propaga e o job falha na fila (retry /
  // dead-letter visível). As condições são as do próprio pedido
  // (turno-mudo.ts): razões legítimas de silêncio nem chegam a corrigir.
  let correcaoTruncou = false;
  const correcaoDoTurnoMudoPedida =
    !preview &&
    liveJob().kind === 'inbound_turn' &&
    turnoMudoPedeCorrecao({
      tentativasDeEnvio: estado.tentativasDeEnvio,
      enviadas: estado.outcomes.length,
      turnoDescartado: estado.turnoDescartado,
      passouParaAEquipe: estado.passouParaAEquipe,
      capDeEnvio: capDeEnvioAtingido(),
    });
  if (correcaoDoTurnoMudoPedida) {
    runLog.warn('turno terminou sem mensagem ao cliente — pedindo UMA correção', {
      job_id: liveJob().id,
    });
    const pedidoDeCorrecao: ModelMessage = { role: 'user', content: CORRECAO_DO_TURNO_MUDO };
    const correcao = await runModelCall(
      pool,
      deps.llmCfg,
      {
        tenantId,
        leadId: leadId || null,
        jobId: job?.id,
        agentId: agentConfig?.agentId ?? null,
        purpose: 'agent_turn',
        system,
        messages: [...openingMessages, ...turn.result.responseMessages, pedidoDeCorrecao],
        tools,
        maxSteps: Math.min(maxSteps, 3),
        ...(agentConfig !== null
          ? {
              model: agentConfig.model,
              llmOverride: {
                provider: agentConfig.provider,
                credentialId: agentConfig.credentialId,
              },
            }
          : {}),
      },
      { registry: deps.registry, log: runLog },
    );
    // Sinal de FALHA da correção: terminou no teto de tokens. Silêncio com
    // finishReason normal (stop/tool-calls) é resposta escolhida, não defeito.
    correcaoTruncou = correcao.result.finishReason === 'length';
    mensagensDoTurno = [...mensagensDoTurno, pedidoDeCorrecao, ...correcao.result.responseMessages];
    if (estado.runError !== null) throw estado.runError;
    if (estado.outcomes.some((o) => o.kind === 'failed')) {
      throw new Error('envio marcado como failed pelo CRM — run re-tentado pela fila');
    }
    runLog.info('correção do turno mudo concluída', { messages_sent: estado.outcomes.length });
  }

  // FALHA TERMINAL VISÍVEL — só com sinal de FALHA, nunca por silêncio
  // deliberado (#2938): o CORRECAO_DO_TURNO_MUDO autoriza o modelo a responder
  // "nada a dizer", então silêncio que persiste com a correção NÃO é defeito.
  // Duas causas, um único bloco (um caso humano por turno, nunca duplicado):
  //  - saída TRUNCADA (finish_reason=length): o modelo cortou no teto de tokens;
  //  - a correção limitada do turno mudo (UMA, `correcaoDoTurnoMudoPedida`
  //    acima) TAMBÉM terminou truncada (`correcaoTruncou`) — sinal de falha.
  // As condições isentam toda razão LEGÍTIMA de silêncio — turno descartado
  // (obsoleto), passagem para a equipe (handoff do cliente), teto de pacing, e
  // `tentativasDeEnvio === 0` (o modelo nunca chegou a chamar `send_message`;
  // se chamou e levou veto, o veto é a razão e já ensinou o modelo). Os flags
  // são re-avaliados DEPOIS da correção: se nela nasceu handoff/teto/descarte,
  // aquilo é a razão e não há caso. O caso humano abre só com `casesEnabled`
  // ligado (mesma régua dos fail-safes clínico e de promessa; `openCase`
  // deduplica caso aberto) — a falha em si continua visível pelo log de erro.
  // O bloco não despacha nada (só registra e abre caso) — logo nunca duplica
  // mensagem; `caso.ok` gateia o move do funil — logo nunca duplica caso
  // humano. O retry continua limitado à UMA correção.
  const silencioSemRazaoLegitima =
    !preview &&
    // Só turno que RESPONDE ao cliente: retomada (followup) cortada não é "cliente sem resposta".
    eTurnoDeResposta(liveJob()) &&
    estado.outcomes.length === 0 &&
    estado.seq === 0 &&
    estado.tentativasDeEnvio === 0 &&
    !estado.turnoDescartado &&
    !estado.passouParaAEquipe &&
    !capDeEnvioAtingido();
  if (silencioSemRazaoLegitima && (saidaTruncada || correcaoTruncou)) {
    const desfechoTerminal = saidaTruncada
      ? 'output_truncated_recovered_failed'
      : 'correction_truncated_failed';
    runLog.error(`${desfechoTerminal} — sem nenhuma mensagem entregue`, {
      job_id: job?.id ?? null,
      kind: liveJob().kind,
      finish_reason: turn.result.finishReason,
      correcao_limitada_rodou: correcaoDoTurnoMudoPedida,
      correcao_truncou: correcaoTruncou,
    });
    // Cases vêm desligados por padrão (`ai_agent_versions.cases_enabled`) — a
    // mesma régua dos fail-safes clínico e de promessa de caso. Com a feature
    // desligada a falha segue visível pelo log de erro acima; o caso para o
    // time (e o move do funil) só acontece com ela ligada e sem caso aberto.
    const haCasoAberto =
      agentConfig?.casesEnabled === true
        ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
        : false;
    if (agentConfig?.casesEnabled === true && !estado.openedCaseThisTurn && !haCasoAberto) {
      try {
        const caso = await openCase(
          pool,
          { tenantId, conversationId: input.conversationId, agentId: agentConfig?.agentId ?? null },
          {
            title: saidaTruncada
              ? 'Resposta do agente truncada — nenhuma mensagem saiu'
              : 'A correção automática da IA também falhou — nenhuma mensagem saiu',
            summary:
              'O cliente ficou sem resposta neste turno: a IA não entregou mensagem nenhuma e a ' +
              'correção automática não recuperou. Atendente precisa retomar a conversa e responder o cliente.',
            blocker: saidaTruncada
              ? 'A resposta da IA veio cortada no limite de tamanho, e mensagem cortada não é enviada ao cliente.'
              : 'O turno terminou sem mensagem para o cliente e a correção automática da IA também veio ' +
                'cortada no limite de tamanho.',
            kind: 'problema',
            source: 'guardrail_autofallback',
            contextSnapshot: buildCaseContextSnapshot(),
          },
        );
        if (caso.ok) {
          estado.openedCaseThisTurn = true;
          moverParaHandoffBestEffort(desfechoTerminal);
        } else {
          // Caso não abriu (já existe um aberto) — a falha fica visível pelo log
          // de erro acima; nada de retry extra aqui.
          runLog.error(`${desfechoTerminal} — caso humano não abriu (já existe)`, {
            job_id: job?.id ?? null,
            code: caso.error.code,
          });
        }
      } catch (err) {
        // Best-effort: erro do banco não pode mascarar a causa original.
        runLog.error(`${desfechoTerminal} — openCase lançou`, {
          job_id: job?.id ?? null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        });
      }
    }
  }

  // ROTEIRO: a pergunta pendente é compromisso. Se o modelo não a fez, o motor
  // a manda — pela MESMA cadeia de guardrails, dentro do teto de envios. Roda
  // mesmo com o teto cheio: registrar que o MODELO fez a pergunta é o que a
  // torna "a pergunta atual" no turno seguinte.
  if (roteiro !== null) {
    await garantirPerguntaDoRoteiro(
      { pool, log: runLog },
      {
        organizationId: tenantId,
        roteiro,
        corposEnviados: estado.corposEnviados,
        enviar: async (texto) => {
          // #1943: turno descartado como obsoleto → a pergunta do roteiro NÃO
          // sai (segue pendente para o turno seguinte). Também vigia o teto
          // de mensagens físicas do turno (F2-15b).
          if (!perguntaDoRoteiroPodeSair({ turnoDescartado: estado.turnoDescartado, seq: estado.seq, maxSendsPerTurn })) return false;
          const chain = await runBeforeSend({
            pool,
            log: runLog,
            agentOperation,
            tenantId,
            leadId,
            jobId: liveJob().id,
            channelSessionId: input.channelSessionId,
            body: texto,
            optedOutThisTurn,
            // Sai no MESMO turno da resposta: sem isto, às 3h com a janela de
            // resposta aberta, o agente responde e a pergunta do roteiro é vetada.
            resposta: eTurnoDeResposta(liveJob()),
            crmDailyLimit: null,
            // A pergunta repete por design (foi feita e não respondida); o
            // anti-blast vetaria justamente o que esta trava garante. Mesmo
            // motivo do aviso de escalação.
            enforceSpinning: false,
            now: clock(),
            sleep: deps.sleep,
            lgpd,
            ...(deps.knobs.disclosureMode !== undefined
              ? { disclosureMode: deps.knobs.disclosureMode }
              : {}),
            send: (finalBody: string) => {
              pararDigitando(); // a mensagem sai agora; renovar depois dela mentiria
              estado.seq += 1;
              return liveChannel().send({
                tenantId,
                leadId,
                jobId: liveJob().id,
                jobClaim: claimOfJob(liveJob()),
                agentOperation,
                seq: estado.seq,
                conversationId: input.conversationId,
                body: finalBody,
              });
            },
          });
          return chain.status !== 'vetoed' && (chain.outcome.kind === 'sent' || chain.outcome.kind === 'already_sent');
        },
      },
    );
  }

  return { mensagensDoTurno };
}
