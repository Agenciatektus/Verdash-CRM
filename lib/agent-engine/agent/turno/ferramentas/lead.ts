/**
 * F8 do turno da IA: ferramentas que gravam no lead (ADR-0006, fatia S6).
 *
 * Ferramentas MOVIDAS de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * texto, ordem ou número de awaits: `update_lead_state`, `save_lead_note` e `schedule_followup`. Cada `criar*` recebe por parâmetro o que a
 * closure lia do escopo do turno; o que ela escrevia vai no `EstadoDoTurno` (o mesmo
 * objeto do orquestrador). Quando cada uma entra no turno continua decidido lá.
 */
import { tool } from '../../../edge/llm/run-model-call';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import { abreAvisoDoEspelhoRecusado, mirrorLeadStageToCrm } from '../../../edge/crm/move-lead-stage';
import { applyLeadStateUpdate } from '../../lead-state';
import { applySaveLeadNote } from '../../lead-notes';
import { applyScheduleFollowup } from '../../schedule-followup';
import type { SaidaDoRoteamento } from '../roteamento';
import type { EstadoDoTurno } from '../estado-do-turno';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { AGENT_TOOL_DEFS } from '../../inbound-turn';

export function criarUpdateLeadState(
  c: ContextoDoTurno,
  r: { agentConfig: SaidaDoRoteamento['agentConfig']; noteRunError: (err: Error) => void },
  estado: EstadoDoTurno,
) {
  const { deps, pool, tenantId, leadId, runLog, liveJob } = c;
  const { agentConfig, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.update_lead_state,
    execute: async (raw) => {
      try {
        const update = await applyLeadStateUpdate(
          pool,
          { tenantId, leadId, jobId: liveJob().id },
          raw,
        );
        if (!update.ok) {
          return update; // erro de ensino (payload fora da whitelist / transição inválida)
        }
        if (update.transition !== null) {
          // Espelho no CRM. Falha NUNCA reverte o harness (fonte da verdade do
          // funil) nem falha o job: humano resolve via inbox_items. Os motivos
          // de MIRROR_WARN_ONLY (tenant sem mapa; humano moveu o card antes) são
          // só warn — estado legítimo do produto não é incidente. Os outros dois
          // merecem aviso PRÓPRIO, cada um no seu: `fora_do_escopo` (nada quebrou,
          // o dono decide se libera o funil) e `perda_sem_motivo` (#917 — o card
          // não anda porque a perda exige um motivo que só o humano pode dar).
          const mirror = await mirrorLeadStageToCrm(pool, deps.crmCfg, {
            tenantId,
            leadId,
            toStage: update.transition.to,
            ...(agentConfig !== null ? { pipelineIds: agentConfig.pipelineIds } : {}),
            ...(update.transition.reason !== undefined
              ? { reason: update.transition.reason }
              : {}),
          });
          if (!mirror.ok) {
            runLog.warn('espelho de stage no CRM falhou — harness mantido', {
              to_stage: update.transition.to,
              reason: mirror.reason,
            });
            // QUAL aviso cada recusa produz, e como ele deixa de se repetir, é
            // decisão de `move-lead-stage` — aqui só se passa o motivo e o
            // lead. Ver `abreAvisoDoEspelhoRecusado`: escrever o
            // `insertInboxItem` à mão neste ponto é o que deixava o `dedupe`
            // sem guarda.
            await abreAvisoDoEspelhoRecusado(pool, tenantId, {
              leadId,
              motivo: mirror.reason,
              detalhe: mirror.detail,
              etapaDeDestino: update.transition.to,
            });
          }
        }
        // F3-11: o estágio que o modelo confirmou (a máquina F2-10 gravou) — base da
        // comparação com a sugestão do classificador no fechamento do run.
        estado.confirmedStage = update.state.stage;
        return {
          ok: true,
          status: 'estado_atualizado',
          stage: update.state.stage,
          message: update.message,
        };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao atualizar o estado do lead — encerre o turno agora.',
          },
        };
      }
    },
  });
}

// F3-05: memória durável por lead. save_lead_note é MUTANTE (fora de
// READ_ONLY_TOOLS); tenant/lead vêm da ROW do job (closure), nunca do payload.
// Hard cap do índice imposto AQUI na escrita (applySaveLeadNote) — estouro vira
// ensino pedindo consolidação, sem gravar (padrão Hermes).
export function criarSaveLeadNote(
  c: ContextoDoTurno,
  r: { noteRunError: (err: Error) => void },
) {
  const { deps, pool, tenantId, leadId } = c;
  const { noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.save_lead_note,
    execute: async (raw) => {
      try {
        const res = await applySaveLeadNote(
          pool,
          { tenantId, leadId },
          { budgetTokens: deps.knobs.notesIndexMaxTokens },
          raw,
        );
        if (!res.ok) {
          return res; // ensino (payload fora da whitelist / orçamento do índice estourado)
        }
        return {
          ok: true,
          status: 'nota_salva',
          superseded: res.superseded,
          message: res.message,
        };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao salvar a nota — encerre o turno agora.',
          },
        };
      }
    },
  });
}

export function criarScheduleFollowup(
  c: ContextoDoTurno,
  r: { followupKnobs: Parameters<typeof applyScheduleFollowup>[1]['knobs']; agentConfig: SaidaDoRoteamento['agentConfig']; noteRunError: (err: Error) => void },
  estado: EstadoDoTurno,
) {
  const { pool, tenantId, leadId, clock } = c;
  const { followupKnobs, agentConfig, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.schedule_followup,
    execute: async (raw) => {
      try {
        // agentId vai junto para a atividade da timeline nascer com AUTORIA: sem
        // ele a linha entra como "Sistema" e o humano não sabe qual agente
        // prometeu voltar — numa org com três agentes isso não responde nada.
        const res = await applyScheduleFollowup(
          pool,
          { clock, knobs: followupKnobs },
          { tenantId, leadId, agentId: agentConfig?.agentId ?? null },
          raw,
        );
        if (!res.ok) {
          return res; // erro de ensino (payload / data no passado / fora da janela)
        }
        estado.followupAgendadoNesteTurno = true;
        return {
          ok: true,
          status: 'agendado',
          agendado_para: res.promisedAt.toISOString(),
          message: res.message,
        };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao agendar o retorno — encerre o turno agora.',
          },
        };
      }
    },
  });
}
