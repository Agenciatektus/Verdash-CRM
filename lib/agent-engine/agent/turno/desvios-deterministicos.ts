/**
 * F5 do turno da IA: os desvios determinísticos (ADR-0006, fatia S5).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Instancia o canal, lê o STOP e a LGPD
 * da abertura e, antes de qualquer chamada de modelo, trata o pedido de humano e
 * a suspeita de opt-out: avisa o lead, passa à equipe e devolve `seguir: false`
 * (o orquestrador faz o `return`).
 */
import type pg from 'pg';

import type { ChannelAdapter } from '../../channel-adapter';
import { WahaChannelAdapter } from '../../edge/channel/waha-adapter';
import { tipoDeEnvio } from '../../guardrails/before-send';
import { claimOfJob } from '../../queue/claim';
import { matchesHandoffKeyword } from '../agent-config';
import { avisarLeadDaEscalacao } from '../aviso-de-escalacao';
import { detectAmbiguousOptOut, detectHumanHandoffRequest, performHumanHandoff } from '../human-handoff';
import { latestInboundSignal } from '../skills';
import { montarBriefingDaPassagem } from '@/lib/escalacao/briefing-da-passagem';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import { eTurnoDeResposta, inboundsNaoRespondidos } from '../inbound-turn';
import type { carregarContextoDoTurno } from './contexto';
import type { ContextoDoTurno, Passo } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;

/** O que F3 e F4 entregam a F5. */
export interface EntradaDosDesvios {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  agentOperation: SaidaDoRoteamento['agentOperation'];
  currentInboundText: SaidaDoContexto['currentInboundText'];
  previous: SaidaDoContexto['previous'];
  openingContext: SaidaDoContexto['openingContext'];
}

export async function tratarDesviosDeterministicos(c: ContextoDoTurno, e: EntradaDosDesvios) {
  const { deps, pool, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const { agentConfig, agentOperation, currentInboundText, previous, openingContext } = e;

  // Seam de canal (F2-25): o envio vai SÓ pela interface ChannelAdapter — o
  // default WAHA-via-CRM envolve o sink F2-06. Instanciado por job (o pool é
  // per-job neste codebase); trocar o adapter não muda nada abaixo.
  // Fase 2B: o envio carrega o ai_agents.id REAL como ator (audit/metadata do
  // CRM apontam o agente publicado, não um id genérico).
  //
  // ⚠️ Ele nasce AQUI, e não depois da compactação como antes, porque os dois
  // desvios determinísticos logo abaixo — pedido de humano e suspeita de
  // opt-out — passaram a FALAR com o lead antes de silenciar. Eles rodam antes
  // de qualquer chamada de modelo; o canal precisa existir antes deles.
  const turnCrmCfg =
    agentConfig !== null ? { ...deps.crmCfg, agentActorId: agentConfig.agentId } : deps.crmCfg;
  const channel = preview
    ? null
    : (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, turnCrmCfg)))(pool);
  const liveChannel = (): ChannelAdapter => {
    if (!channel) throw new Error('preview_transport_forbidden');
    return channel;
  };
  // STOP lido no turno (fonte: CRM via get_lead_context) — combinado com o cache
  // durável leads.is_opted_out no gate 1 da cadeia (F2-13).
  const optedOutThisTurn = openingContext.context.contact.is_blocked;
  // LGPD (F4-09): base legal/anonimização do CRM lidas na abertura do turno (fonte confiável,
  // regra dura nº 1) — o gate LGPD da cadeia veta anonimizado (sempre) e 1º toque de prospecção
  // sem base legal. Resposta a inbound (isProspecting=false) não dispara o veto de base legal.
  const lgpd = openingContext.lgpd;

  /** Argumentos fixos do aviso ao lead — os dois desvios abaixo só trocam o motivo. */
  const avisoDaEscalacao = () => ({
    ids: {
      tenantId,
      leadId,
      conversationId: input.conversationId,
      channelSessionId: input.channelSessionId,
      jobId: liveJob().id,
      jobClaim: claimOfJob(liveJob()),
      agentOperation,
    },
    base: {
      channel: liveChannel(),
      optedOutThisTurn,
      // #2112: o TIPO do turno decide a janela do aviso — `inbound_turn`/
      // `case_reply_turn` respondem a quem escreveu; `followup_turn` é disparo
      // (retomada), e o aviso de escalação dentro dele tem de cair na janela de
      // `window_*`. Mesmo discriminador do resto do turno.
      origem: tipoDeEnvio(eTurnoDeResposta(liveJob())),
      now: clock(),
      log: runLog,
      lgpd,
      agentId: agentConfig?.agentId ?? null,
      ...(deps.knobs.disclosureMode !== undefined
        ? { disclosureMode: deps.knobs.disclosureMode }
        : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    },
  });

  // F4-06 (acceptance 1): detecção DETERMINÍSTICA (regex PT-BR, sem LLM) de pedido explícito
  // de atendimento humano na última mensagem do lead. Handoff é cidadão de 1ª classe (exigência
  // Meta fiscalizada, blueprint 5.5) — dispara ANTES do modelo: o bot não gasta LLM.
  // A ação (CRM force_human + cache + cancela crons + inbox) é idempotente.
  //
  // ⚠️ ORDEM: AVISA e SÓ ENTÃO silencia. Não é preferência de redação — é a única
  // ordem que funciona. `performHumanHandoff` grava `contacts.force_human = true`,
  // e o gate 1 da cadeia (`stopGate`) lê `(is_blocked or force_human)` DIRETO da
  // fonte, sob o lock, a cada tentativa de envio. Avisar depois seria avisar
  // ninguém: a própria trava que a passagem acabou de armar veta a mensagem.
  // DUAS perguntas diferentes, duas fontes diferentes — e emendá-las foi o dano
  // colateral medido do pin.
  //
  //  • `mensagemDoJob` é O QUE ESTE TURNO RESPONDE. Vem pinada no
  //    `inbound_message_id`, para um registro concorrente não sequestrar o turno.
  //  • `inboundsPendentes` é O QUE O CLIENTE DISSE e ainda não foi respondido.
  //    Handoff, opt-out e urgência leem daqui: são coisas que não podem passar
  //    despercebidas só porque chegaram na segunda mensagem de uma rajada, que o
  //    drain coalesce no job da primeira.
  const mensagemDoJob =
    currentInboundText ?? latestInboundSignal(openingContext.context.messages);
  const inboundsPendentes = inboundsNaoRespondidos(openingContext.context.messages);
  if (
    !preview &&
    inboundsPendentes.some(
      (texto) =>
        detectHumanHandoffRequest(texto) ||
        (agentConfig !== null && matchesHandoffKeyword(texto, agentConfig.handoffKeywords)),
    )
  ) {
    const aviso = await avisarLeadDaEscalacao(pool, avisoDaEscalacao().ids, {
      ...avisoDaEscalacao().base,
      motivo: 'pediu_humano',
    });
    // `inboundsPendentes` JÁ está em memória (linha acima): a fala literal do
    // cliente entra no briefing a custo zero. É a diferença entre quem assume
    // ler "o cliente pediu uma pessoa" e ler o que ele de fato escreveu.
    const briefing = montarBriefingDaPassagem({
      checkpoint: previous,
      pendentesDoCliente: inboundsPendentes,
      motivo: { codigo: 'requested_human' },
    });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'requested_human',
        conversationSummary: briefing.body,
        passagem: { origem: 'pedido_explicito', motivoCodigo: 'requested_human', briefing },
        avisoAoLead: aviso,
        log: runLog,
      },
    );
    runLog.info('handoff humano acionado por pedido explícito do lead (detecção determinística)', {
      kind: liveJob().kind,
      lead_avisado: aviso.avisado,
    });
    // bot silencia: o aviso já saiu, e nada mais sai neste turno
    return { seguir: false, motivo: 'pedido_de_humano' } as const;
  }

  // F4-07: STOP AMBÍGUO ("para de me mandar isso", "não quero mais receber", "me tira da
  // lista", ou a palavra-chave STOP/PARAR/SAIR sozinha). Detecção CONSERVADORA — na dúvida
  // é STOP: o bot silencia JÁ (sem LLM, sem envio) via o MESMO mecanismo durável do handoff
  // (bot_silenced_until='infinity', que SOBREVIVE à leitura do CRM que sobrescreve o cache
  // is_opted_out) e escala à inbox para o humano confirmar o opt-out real (is_blocked) no
  // CRM. Cancela os follow-ups agendados de tabela. Nada disso reverte (regra dura nº 2).
  if (!preview && inboundsPendentes.some((texto) => detectAmbiguousOptOut(texto))) {
    // O aviso daqui NÃO fala em atendente — quem pediu para parar não quer ouvir
    // sobre atendimento (`textoDoAviso`, motivo `suspeita_de_opt_out`). Ele
    // CONFIRMA a parada, que é o padrão de mensageria para um opt-out, e diz que
    // uma pessoa vai conferir. Sair calado deixaria a pessoa sem saber se o
    // pedido dela foi ouvido — e ela pediu justamente para ser ouvida.
    const aviso = await avisarLeadDaEscalacao(pool, avisoDaEscalacao().ids, {
      ...avisoDaEscalacao().base,
      motivo: 'suspeita_de_opt_out',
    });
    const briefing = montarBriefingDaPassagem({
      checkpoint: previous,
      pendentesDoCliente: inboundsPendentes,
      motivo: { codigo: 'suspected_optout' },
    });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'suspected_optout',
        conversationSummary: briefing.body,
        inboxTitle: 'Suspeita de opt-out — confirmar bloqueio do contato no CRM',
        passagem: { origem: 'opt_out_provavel', motivoCodigo: 'suspected_optout', briefing },
        avisoAoLead: aviso,
        log: runLog,
      },
    );
    runLog.info('possível opt-out detectado no inbound — bot silenciado e escalado ao humano', {
      kind: liveJob().kind,
      lead_avisado: aviso.avisado,
    });
    // bot silencia: a confirmação já saiu, e nada mais sai neste turno
    return { seguir: false, motivo: 'suspeita_de_opt_out' } as const;
  }

  return {
    seguir: true,
    valor: { channel, liveChannel, optedOutThisTurn, lgpd, avisoDaEscalacao, mensagemDoJob, inboundsPendentes },
  } as const satisfies Passo<unknown>;
}

/** O que os desvios devolvem ao turno quando ele segue (o envio da S7 lê os campos). */
export type SaidaDosDesvios = Extract<Awaited<ReturnType<typeof tratarDesviosDeterministicos>>, { seguir: true }>['valor'];
