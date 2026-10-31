/**
 * F13 do turno da IA: os efeitos pós-turno (ADR-0006, fatia S3).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Roda depois de o checkpoint ser gravado:
 * enfileira o Operador, emite o diff do checkpoint, recalcula a nota do negócio,
 * grava o candidato a golden, aplica o veto `is_blocked` e reagenda pelo cap de
 * envio. As duas saídas por `JobSettledError` continuam lançadas daqui, como antes.
 */
import { insertInboxItem } from '../../db/repository';
// applySendOutcome é disposição de FILA (cancel/reschedule + cache de opt-out), não
// egress de canal — o envio em si vai pelo adapter (ChannelAdapter). Ver F2-25.
import { applySendOutcome } from '../../edge/crm/send-message';
import { detectUrgencySignal } from '../../guardrails/sinal-de-urgencia';
import { claimOfJob } from '../../queue/claim';
import { rescheduleJob } from '../../queue/queue';
import { perguntarUrgenciaAoJev, registrarUrgenciaDoJev } from '@/lib/ai/decisao/urgencia';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import { JobSettledError } from '../inbound-turn';
import type { ContextoDoTurno } from './portoes-de-entrada';

/** O que F13 lê do estado do turno, no fim dele (ADR-0006, D5). */
import type { EstadoNoFimDoTurno } from './efeitos-pos-turno';

/**
 * O desfecho do envio no fim do turno (ADR-0006, S3): veto `is_blocked`, reagendamento
 * pelo cap de envio e a pergunta de urgência. Movido de `executarEfeitosPosTurno`, que o
 * chama no mesmo ponto; dividido só para caber no teto de 300 linhas por arquivo.
 */
export async function aplicarDesfechoDoEnvio(
  c: ContextoDoTurno,
  e: EstadoNoFimDoTurno,
): Promise<void> {
  const { deps, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const {
    outcomes,
    pacingCapVeto,
    inboundsPendentes,
    turn,
  } = e;
  const blocked = outcomes.find((o) => o.kind === 'blocked');
  if (blocked !== undefined) {
    // veto permanente (regra dura nº 2): cancela o job e cacheia o opt-out —
    // depois do checkpoint (o artefato do turno fica registrado mesmo em veto).
    await applySendOutcome(
      pool,
      blocked,
      {
        jobId: liveJob().id,
        workerId: ctx.workerId,
        tenantId,
        leadId,
        jobClaim: claimOfJob(liveJob()),
      },
      { queuedRetryDelayMs: deps.knobs.queuedRetryDelayMs },
    );
    throw new JobSettledError(
      'turno encerrado com veto do sink (is_blocked) — job cancelado em definitivo, checkpoint gravado',
    );
  }

  // Cap de warm-up/diário vetou toda tentativa de envio deste turno e nada saiu: sem
  // isto, o job terminava 'ok' com `messages_sent: 0` e o lead ficava sem resposta até
  // escrever de novo por conta própria (ou nunca) — medido em produção, 2026-08-29
  // (número no dia 0 de warm-up, cap batido pelo volume da própria conversa de teste).
  // Mesmo contrato da janela anti-ban (linha ~1233): adia sem gastar `attempts`, o job
  // volta a 'pending' na hora certa e o mesmo turno roda de novo, com o mesmo contexto.
  if (pacingCapVeto !== null && outcomes.length === 0) {
    // Capturado num `const`: `pacingCapVeto` é reatribuído numa closure em outro ponto do
    // turno, e o TS reabre a união (perde o `!== null`) depois de qualquer chamada — o
    // valor JÁ CHECADO não muda, só a inferência precisa de um nome que não reatribui.
    const veto = pacingCapVeto;
    await rescheduleJob(pool, liveJob().id, ctx.workerId, {
      acquiredAt: claimOfJob(liveJob())?.acquired_at,
      delayMs: Math.max(veto.nextAllowedAt.getTime() - clock().getTime(), 1_000),
      reason: `cap de envio (${veto.code}) atingido — turno adiado para a próxima abertura`,
    });
    runLog.info('turno adiado — cap de envio atingido antes de qualquer mensagem sair', {
      code: veto.code,
      proxima_abertura: veto.nextAllowedAt.toISOString(),
    });
    // O reagendamento acima trata toda mensagem represada igual — um lead relatando
    // risco de segurança (freio, fumaça, bateria esquentando) esperaria a mesma janela
    // que um "bom dia" qualquer, às vezes horas (medido num tenant de produção:
    // 20h+ represado num relato de bateria superaquecendo). Sem furar o cap de
    // warm-up/diário em si (proteção anti-banimento — mexer nisso é decisão de
    // produto, não deste guardrail), abre um alerta CRÍTICO na Central agora, pra um
    // humano poder responder manualmente pelo próprio WhatsApp enquanto o número
    // aquece. Dedupe por (kind, ref) — não reabre um já aberto pra esta conversa.
    //
    // A REGRA continua decidindo (#2232): ela decide; onde não, o Jev só OPINA (R3),
    // nasce em observação e, com "Avisar a equipe", abre o MESMO alerta
    // `kind='handoff'`, sem a frase do cliente (#1747).
    if (inboundsPendentes.some((texto) => detectUrgencySignal(texto))) {
      await insertInboxItem(
        pool,
        tenantId,
        {
          kind: 'handoff',
          severity: 'critical',
          title: 'Lead com sinal de urgência represado pelo cap de envio do número',
          body:
            `Mensagem do lead parece relatar risco/urgência, mas o número está em ` +
            `warm-up/bateu o cap diário (${veto.code}) — a resposta automática só sai em ` +
            `${veto.nextAllowedAt.toISOString()}. Considere responder manualmente pelo ` +
            `WhatsApp enquanto o número aquece.`,
          refKind: 'conversation',
          refId: input.conversationId,
        },
        'kind_e_ref',
      ).catch((err) => {
        runLog.warn('alerta de urgência represada por warmup_cap falhou (best-effort)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!preview) {
      const mensagemRepresada = inboundsPendentes[inboundsPendentes.length - 1] ?? '';
      const urgencia = await perguntarUrgenciaAoJev(
        pool,
        {
          organizationId: tenantId,
          conversationId: input.conversationId || null,
          messageId: input.inboundMessageId ?? null,
          contactId: leadId || null,
          jobId: liveJob().id,
          mensagem: mensagemRepresada,
        },
        deps.jev,
      );
      if (urgencia !== null) {
        await registrarUrgenciaDoJev(pool, {
          organizationId: tenantId,
          contactId: leadId || null,
          conversationId: input.conversationId || null,
          messageId: input.inboundMessageId ?? null,
          jobId: liveJob().id,
          urgencia,
        });
        if (urgencia.percebeu && urgencia.estado === 'decidindo') {
          await insertInboxItem(
            pool,
            tenantId,
            {
              kind: 'handoff',
              severity: 'critical',
              title: 'Lead com risco percebido pelo modelo de decisão represado pelo cap de envio',
              body:
                `A regra de urgência de hoje não reconheceu o risco, mas o modelo de decisão ` +
                `percebeu, numa mensagem represada, risco à segurança ou à saúde ` +
                `(origem: percebido pelo modelo de decisão, visível só para a equipe). O ` +
                `número está em warm-up/bateu o cap diário (${veto.code}) — a resposta ` +
                `automática só sai em ${veto.nextAllowedAt.toISOString()}. Considere ` +
                `responder manualmente pelo WhatsApp enquanto o número aquece.`,
              refKind: 'conversation',
              refId: input.conversationId,
            },
            'kind_e_ref',
          ).catch((err) => {
            runLog.warn('alerta de urgência percebida pelo modelo represada falhou (best-effort)', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    }
    throw new JobSettledError(
      'cap de envio atingido — job reagendado para a próxima abertura, sem mensagem enviada',
    );
  }

  runLog.info('turno do agente concluído', {
    kind: liveJob().kind,
    messages_sent: outcomes.length,
    model: turn.model,
  });
}
