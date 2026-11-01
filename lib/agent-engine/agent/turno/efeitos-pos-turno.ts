/**
 * F13 do turno da IA: os efeitos pós-turno (ADR-0006, fatia S3).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Roda depois de o checkpoint ser gravado:
 * enfileira o Operador, emite o diff do checkpoint, recalcula a nota do negócio,
 * grava o candidato a golden, aplica o veto `is_blocked` e reagenda pelo cap de
 * envio. As duas saídas por `JobSettledError` continuam lançadas daqui, como antes.
 */
import type { ChannelSendResult } from '../../channel-adapter';
import { insertInboxItem } from '../../db/repository';
// applySendOutcome é disposição de FILA (cancel/reschedule + cache de opt-out), não
// egress de canal — o envio em si vai pelo adapter (ChannelAdapter). Ver F2-25.
import { enqueueJob } from '../../queue/queue';
import type { CheckpointContent, LeadCheckpointRow } from '../abertura/checkpoint';
import type { PublishedAgentConfig } from '../agent-config';
import { promessasEmAberto } from '../declaracao';
import type { LeadStage } from '../lead-state';
import { recordStageDivergenceCandidate } from '../stage-classifier';
import { diffCheckpoint } from '@/lib/leads/checkpoint-diff';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import { recalculaScoreDoLead } from '@/lib/leads/score-writer';
// Valores lidos só dentro da função (nunca na carga do módulo): o ciclo de import é seguro.
import { decidirSeEnfileiraOperador } from '../inbound-turn';
import type { ContextoDoTurno } from './portoes-de-entrada';

/** O que F13 lê do estado do turno, no fim dele (ADR-0006, D5). */
import { aplicarDesfechoDoEnvio } from './desfecho-do-envio';

export interface EstadoNoFimDoTurno {
  agentConfig: PublishedAgentConfig | null;
  content: CheckpointContent;
  checkpointAnterior: LeadCheckpointRow | null;
  closing: { callId?: string | null };
  stageSuggestion: LeadStage | null;
  confirmedStage: LeadStage | null;
  outcomes: ChannelSendResult[];
  pacingCapVeto: { code: string; nextAllowedAt: Date } | null;
  inboundsPendentes: string[];
  turn: { model: string };
}

export async function executarEfeitosPosTurno(
  c: ContextoDoTurno,
  e: EstadoNoFimDoTurno,
): Promise<void> {
  const { deps, pool, input, tenantId, leadId, runLog, liveJob } = c;
  const {
    agentConfig,
    content,
    checkpointAnterior,
    closing,
    stageSuggestion,
    confirmedStage,
  } = e;

  // ── O TURNO DO OPERADOR (spec 16 §3.2) ─────────────────────────────────────
  //
  // Enfileirado AQUI, pelo RUNTIME, logo depois de o checkpoint existir — nunca
  // por decisão do modelo. Um Conversador que "chama" o Operador devolveria o
  // problema inteiro: voltaria a depender de o modelo lembrar, e o turno em que
  // ele não achasse necessário seria um lead parado no funil, em silêncio.
  //
  // Depois do checkpoint porque a declaração É o insumo do Operador; enfileirar
  // antes criaria uma corrida em que ele leria o checkpoint do turno ANTERIOR e
  // agiria sobre um turno que não é o seu.
  //
  // Fire-and-forget: falha ao enfileirar NÃO derruba um turno que já respondeu
  // ao cliente. O `sourceEventId` é o job do Conversador, então o retry da fila
  // não gera um segundo Operador para o mesmo turno.
  const disparo = decidirSeEnfileiraOperador({
    temAgentePublicado: agentConfig !== null,
    papelLigado: agentConfig?.operatorEnabled ?? false,
  });
  if (!disparo.enfileira) {
    runLog.info('turno do operador não enfileirado', { porque: disparo.porque });
  } else {
    try {
      const { deduped } = await enqueueJob(pool, tenantId, {
        kind: 'operator_turn',
        leadId,
        sourceEventId: liveJob().id,
        payload: {
          conversation_id: input.conversationId,
          origin_job_id: liveJob().id,
          agent_id: agentConfig?.agentId ?? null,
        },
      });
      runLog.info('turno do operador enfileirado', { deduped });
    } catch (err) {
      runLog.error('turno do operador NÃO foi enfileirado (o turno segue)', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
      // O CATCH TINHA A DOUTRINA CERTA E A CONCLUSÃO ERRADA.
      //
      // "O aviso não pode derrubar o turno que já respondeu ao cliente" está certo.
      // "Então basta um log" não: o enfileiramento é o ÚNICO mecanismo que garante o
      // disparo do papel, e falhar aqui significa que a promessa que o Conversador
      // acabou de fazer não terá dono e ninguém vai saber.
      //
      // É a mesma lição que este arquivo já aplicou no catch das capacidades MCP,
      // onde o comentário diz que a versão anterior "dizia 'o humano vê o log'. Não
      // vê." Lição aplicada numa ocorrência e não na irmã.
      //
      // Só quando HÁ promessa: sem ela o Operador teria decidido "nada a fazer", e
      // item sem ação é ruído — ruído ensina a ignorar a Central.
      const promessas = promessasEmAberto(content.declaracao ?? null);
      if (promessas.length > 0) {
        try {
          await insertInboxItem(
            pool,
            tenantId,
            {
              kind: 'promise_unfulfilled',
              severity: 'warn',
              title: 'Um retorno prometido a um cliente ficou sem dono',
              body:
                'O assistente prometeu algo a esta pessoa nesta conversa e o passo que registra ' +
                'o cumprimento não chegou a ser agendado. Abra a conversa, veja o que foi ' +
                'combinado e cumpra você mesmo.',
              refKind: 'conversation',
              refId: input.conversationId,
            },
            'kind_e_ref',
          );
        } catch (erroDoAviso) {
          runLog.error('aviso de promessa sem dono não foi gravado', {
            error: (erroDoAviso instanceof Error
              ? erroDoAviso.message
              : String(erroDoAviso)
            ).slice(0, 120),
          });
        }
      }
    }
  }

  const mudanca = diffCheckpoint(
    checkpointAnterior
      ? {
          commitments: (checkpointAnterior.commitments ?? []) as string[],
          objections: (checkpointAnterior.objections ?? []) as string[],
          next_action: checkpointAnterior.next_action ?? null,
          rolling_summary: checkpointAnterior.rolling_summary ?? null,
        }
      : null,
    content,
  );

  if (mudanca.emit) {
    try {
      const r = await emitAgentActivityForContact({
        pool,
        organizationId: tenantId,
        contactId: leadId,
        type: 'ai_turn',
        sourceModule: 'agent',
        sourceId: liveJob().id,
        // O lastro é a chamada de modelo que PRODUZIU este checkpoint
        // (llm_calls.id). Sem ele a linha entraria como 'system' e perderia a
        // autoria justamente no evento mais "de IA" que existe.
        ...(closing.callId ? { evidence: { llm_call_ids: [closing.callId] } } : {}),
        ...(agentConfig?.agentId ? { agentId: agentConfig.agentId } : {}),
        reason: mudanca.reason,
        payload: {
          added_commitments: mudanca.addedCommitments,
          added_objections: mudanca.addedObjections,
          next_action_changed: mudanca.nextActionChanged,
        },
      });
      if (!r.routed) {
        runLog.info('checkpoint sem negócio para pendurar: registrado no event_log', {
          reason: r.reason,
        });
      }
    } catch (err) {
      // A timeline do turno não pode derrubar o turno.
      runLog.error('falha ao registrar atividade de checkpoint (segue)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // ── A NOTA DO NEGÓCIO ──────────────────────────────────────────────────────
  //
  // O turno acabou de mexer em TUDO que a fórmula lê: compromissos e objeções
  // (o checkpoint acima) e a qualificação BANT (`lead_state`, escrita pelo
  // update_lead_state do modelo). Recalcular aqui é recalcular no instante em
  // que os sinais mudaram — não há evento melhor.
  //
  // ⚠️ POR QUE ISTO EXISTE: `recalculaScoreDoLead` estava escrita, testada e
  // com constraint no banco exigindo o `reason` — e SEM UM ÚNICO CHAMADOR no
  // repositório inteiro. Nenhuma nota jamais foi calculada. O modo de falha era
  // mudo: o card simplesmente não mostrava número, e "não tem nota ainda" é
  // indistinguível de "ninguém nunca calcula".
  //
  // Fora do `if (mudanca.emit)` DE PROPÓSITO: o BANT muda em turnos que não
  // mexem no checkpoint, e esses turnos também mudam a nota. Amarrar o cálculo
  // à emissão da atividade faria a nota envelhecer em silêncio — o mesmo
  // defeito, um andar acima.
  //
  // Falha aqui não derruba o turno: nota é derivado, e o próximo turno
  // recalcula. O que não pode é o cliente ficar sem resposta por causa dela.
  try {
    const alvo = await resolveActiveLeadForContact(
      (
        await pool.query<LeadCandidate>(
          `select l.id, l.organization_id, l.pipeline_id, l.status,
                l.last_activity_at, l.created_at
           from crm_leads l
          where l.organization_id = $1 and l.contact_id = $2`,
          [tenantId, leadId],
        )
      ).rows,
    );
    if (alvo.routed) {
      const r = await recalculaScoreDoLead(pool, tenantId, alvo.leadId);
      runLog.info('score do negócio recalculado', {
        lead_id: alvo.leadId,
        gravou: r.gravou,
        ...(r.motivo !== undefined ? { motivo: r.motivo } : {}),
      });
    }
  } catch (err) {
    runLog.error('falha ao recalcular score (segue)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
  }

  // F3-11: divergência classificador×modelo. O classificador sugeriu um estágio; se o
  // modelo confirmou (via update_lead_state — a máquina F2-10) um estágio DIFERENTE, o
  // desacordo vira candidato ao golden set (linha em `golden_candidates` — mesma tabela
  // da F3-09, migration 0428). Sem sugestão, sem confirmação, ou concordância ⇒ nenhuma
  // linha (zero divergência).
  if (
    deps.knobs.goldenCandidates === true &&
    stageSuggestion !== null &&
    confirmedStage !== null &&
    stageSuggestion !== confirmedStage
  ) {
    await recordStageDivergenceCandidate(
      pool,
      {
        tenantId,
        leadId,
        jobId: liveJob().id,
        divergence: { suggested: stageSuggestion, confirmed: confirmedStage },
      },
      runLog,
    );
  }

  await aplicarDesfechoDoEnvio(c, e);
}
