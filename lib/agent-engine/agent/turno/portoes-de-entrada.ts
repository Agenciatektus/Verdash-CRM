/**
 * F2 do turno da IA: os portões de entrada (ADR-0006, fatia S1).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Lê as camadas e o fuso da org e decide
 * se o turno segue: lead em handoff, conversa não elegível ou laço com robô param
 * (o orquestrador faz o `return`); fora da janela anti-ban o job é reagendado e o
 * `JobSettledError` é lançado aqui mesmo, como antes.
 */
import type pg from 'pg';

import type { Logger } from '../../obs/logger';
import { claimOfJob } from '../../queue/claim';
import { rescheduleJob, type JobRow } from '../../queue/queue';
import { janelaDeEnvioAberta, proximaAberturaDaJanela } from '../../pacing/engine';
import { loadChannelKnobs } from '../../pacing/store';
import { avisarJanelaFechada, resolverAvisoDeJanela } from '../../pacing/aviso-de-janela';
import { lerCamadasDaOrg } from '../../guardrails/camadas-da-org';
import { isLeadInHandoff } from '../human-handoff';
import { fusoDaOrganizacao } from '../fuso-da-org';
import { decidirElegibilidadeDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';
import { conversaEmLacoComRobo } from '@/lib/ai/elegibilidade/consulta-laco';
import type { TurnPreview } from '../preview';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import {
  ALLOWLIST_TTL_MS_PADRAO,
  JobSettledError,
  eTurnoDeResposta,
  turnoVaiFalarComOLead,
  type AgentTurnInput,
  type InboundTurnDeps,
} from '../inbound-turn';

/** Saída antecipada como valor (ADR-0006, D3): só o orquestrador sai da função. */
export type Passo<T> = { seguir: true; valor: T } | { seguir: false; motivo: string };

/** O que F1 produz e as fases leem (ADR-0006, D5). */
export interface ContextoDoTurno {
  deps: InboundTurnDeps;
  job: JobRow | null;
  pool: pg.Pool;
  ctx: { workerId: string };
  input: AgentTurnInput;
  preview?: TurnPreview;
  tenantId: string;
  leadId: string;
  clock: () => Date;
  runLog: Logger;
  liveJob: () => JobRow;
}

export interface SaidaDosPortoes {
  camadas: Awaited<ReturnType<typeof lerCamadasDaOrg>>;
  fusoDaOrg: string;
}

export async function avaliarPortoesDeEntrada(
  c: ContextoDoTurno,
): Promise<Passo<SaidaDosPortoes>> {
  const { deps, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;

  // AS DUAS CAMADAS QUE CUSTAM DINHEIRO, resolvidas UMA vez por turno.
  //
  // Os knobs (`deps.knobs.jailbreak`, `deps.knobs.promiseSemantic`) nascem no boot
  // do worker e valem para a instalação inteira; a linha em `org_guardrail_layers`
  // é a preferência de QUEM PAGA a consulta. Sem linha, `camadaLigada` devolve o
  // padrão do ambiente — aplicar a migration não muda o comportamento de quem já
  // decidiu no `.env`.
  //
  // Lido aqui, e não em cada ponto de uso: os dois consumidores ficam a ~900
  // linhas de distância um do outro, e duas queries para a mesma pergunta viram,
  // com o tempo, duas respostas.
  const camadas = await lerCamadasDaOrg(pool, tenantId);
  // O fuso da ORGANIZAÇÃO — o que o bloco `## Agora` usa lá embaixo, na montagem
  // da abertura. Lido aqui pela mesma razão da linha acima: uma query por turno,
  // longe do ponto de uso, para não virar duas respostas para a mesma pergunta.
  // Nunca lança e nunca vem vazio (ver `fuso-da-org.ts`).
  const fusoDaOrg = await fusoDaOrganizacao(pool, tenantId, runLog);

  // F4-06 (acceptance 2): lead em handoff humano → NO-OP no INÍCIO do turno, antes de
  // qualquer chamada de modelo/CRM. O bot silenciou (bot_silenced_until='infinity', cache
  // do force_human do CRM) e só o humano/CRM libera — o agente nunca reassume (regra dura 2).
  if (!preview && (await isLeadInHandoff(pool, tenantId, leadId))) {
    runLog.info('turno pulado — lead em handoff humano (bot silenciado)', { kind: liveJob().kind });
    return { seguir: false, motivo: 'turno pulado — lead em handoff humano (bot silenciado)' };
  }

  // GATE DE ELEGIBILIDADE (opt-in por canal — `metadata.ai_gate = 'allowlist'`).
  // Segunda checagem, defesa em profundidade: o drain já barra antes de
  // enfileirar, mas um job pode ter sido enfileirado quando a conversa ainda
  // estava autorizada e um humano assumiu no meio-tempo, ou o gate do canal
  // mudou. Canal 'open' (default) → `permite:true`, nada muda. NO-OP no início do
  // turno, antes de qualquer chamada de modelo — mesmo lugar e mesmo custo do
  // veto de handoff acima.
  if (!preview) {
    try {
      const elegib = await decidirElegibilidadeDaConversa(pool, {
        organizationId: tenantId,
        conversationId: input.conversationId,
        agora: clock(),
        ttlMs: deps.knobs.allowlistTtlMs ?? ALLOWLIST_TTL_MS_PADRAO,
      });
      if (elegib !== null && !elegib.permite) {
        runLog.info('turno pulado — conversa não elegível para IA', {
          kind: liveJob().kind,
          motivo: elegib.motivo,
        });
        return { seguir: false, motivo: 'turno pulado — conversa não elegível para IA' };
      }
      // Freio de laço com robô (URA/autoresposta): não roda o turno e silencia a conversa.
      if (
        await conversaEmLacoComRobo(
          pool,
          { organizationId: tenantId, conversationId: input.conversationId, agora: clock() },
          runLog,
        )
      ) {
        runLog.info('turno pulado — laço com robô', { kind: liveJob().kind });
        return { seguir: false, motivo: 'turno pulado — laço com robô' };
      }
      // KEEP-ALIVE: enquanto a conversa autorizada está viva, renova o carimbo —
      // assim uma negociação de semanas não expira pela janela de validade, mas um
      // contato que veio de uma submissão e sumiu volta a NÃO ser elegível depois
      // da janela. Só no modo 'allowlist' (motivo 'autorizado'); fire-and-forget.
      if (elegib !== null && elegib.motivo === 'autorizado' && liveJob().kind === 'inbound_turn') {
        pool
          .query(
            `update contacts set ai_authorized_at = now()
           where organization_id = $1 and id = $2 and ai_authorized_at is not null`,
            [tenantId, leadId],
          )
          .catch((err: unknown) => {
            runLog.warn('keep-alive da autorização de IA falhou', {
              error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
            });
          });
      }
    } catch (err) {
      runLog.warn('checagem de elegibilidade falhou no turno — seguindo', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
  }

  // JANELA ANTI-BAN (7h–22h por padrão, fuso do tenant): fora dela o turno é
  // ADIADO, não gasto.
  //
  // ⚠️ ISTO CONSERTA UMA MENSAGEM PERDIDA, não um custo. O gate de envio
  // (`pacingGate` em guardrails/before-send.ts) já vetava o envio fora da
  // janela — mas, no caminho do agente, esse veto vira ERRO DE ENSINO devolvido
  // ao modelo dentro do tool `send_message`. O turno terminava `ok`, sem
  // exceção, sem reagendamento e sem mensagem: o lead escrevia 22h e não recebia
  // NADA, nem naquele momento nem às 7h. Medido em produção (2026-08-18): run
  // `agent_turn` com status `ok` às 22:56 e zero outbound na conversa.
  //
  // O caminho determinístico de re-entrada já fazia o certo — "veto por JANELA
  // anti-ban não dropa — re-agenda para a próxima abertura" (followup-turn.ts) —
  // e é essa regra que passa a valer também para a resposta do agente.
  //
  // Só a JANELA adia. Cap diário e warm-up continuam com o gate de envio: eles
  // dependem de quanto já saiu hoje, e antecipá-los aqui adiaria turno que, na
  // hora do envio, teria passado.
  if (!preview && turnoVaiFalarComOLead(liveJob())) {
    const { knobs } = await loadChannelKnobs(pool, tenantId, input.channelSessionId, runLog);
    const agora = clock();
    const resposta = eTurnoDeResposta(liveJob());
    // `resposta` separa as janelas: reação a quem escreveu lê `resposta*` (0495,
    // que herda `window*` quando vazia); retomada e disparo leem `window*`.
    if (!janelaDeEnvioAberta(agora, knobs, resposta)) {
      const abertura = proximaAberturaDaJanela(agora, knobs, resposta);
      await rescheduleJob(pool, liveJob().id, ctx.workerId, {
        acquiredAt: claimOfJob(liveJob())?.acquired_at,
        delayMs: Math.max(abertura.getTime() - agora.getTime(), 1_000),
        reason: 'fora da janela anti-ban de envio — turno adiado para a abertura',
      });
      runLog.info('turno adiado — fora da janela anti-ban de envio', {
        janela: `${resposta ? knobs.respostaStartHour : knobs.windowStartHour}h-${resposta ? knobs.respostaEndHour : knobs.windowEndHour}h`,
        tipo: resposta ? 'resposta' : 'retomada',
        timezone: knobs.timezone,
        abertura: abertura.toISOString(),
      });
      // O adiamento deixa RASTRO VISÍVEL. Sem isto, o único registro de que o
      // número está calado morre no log do contêiner — e foi assim que uma
      // instalação passou um domingo inteiro muda, com todos os contêineres
      // `healthy` e o dono sem nada para olhar. Um aviso por canal, deduplicado
      // enquanto durar o silêncio; ver o cabeçalho de `aviso-de-janela.ts`.
      //
      // Fire-and-forget: telemetria nunca derruba um turno que já decidiu o que
      // fazer com a mensagem do cliente — e o job JÁ foi reagendado acima.
      try {
        const criados = await avisarJanelaFechada(pool, {
          tenantId,
          channelSessionId: input.channelSessionId,
          abertura,
          janela: `${resposta ? knobs.respostaStartHour : knobs.windowStartHour}h-${resposta ? knobs.respostaEndHour : knobs.windowEndHour}h`,
          timezone: knobs.timezone,
          domingoDesligado: !knobs.allowSunday,
        });
        if (criados > 0) {
          runLog.info('aviso de janela fechada aberto na Central', {
            channel_session_id: input.channelSessionId,
          });
        }
      } catch (err) {
        runLog.warn('não consegui abrir o aviso de janela fechada', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
        });
      }
      throw new JobSettledError(
        'fora da janela anti-ban — job reagendado para a abertura da janela',
      );
    }
    // A janela está ABERTA: se havia aviso de silêncio pendurado, ele morre
    // AQUI — no mesmo ponto que o abriu. Um aviso que só o humano fecha vira
    // dívida: na segunda o número volta a atender e o painel seguiria dizendo
    // que está calado.
    try {
      await resolverAvisoDeJanela(pool, {
        tenantId,
        channelSessionId: input.channelSessionId,
      });
    } catch (err) {
      runLog.warn('não consegui resolver o aviso de janela fechada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  return { seguir: true, valor: { camadas, fusoDaOrg } };
}
