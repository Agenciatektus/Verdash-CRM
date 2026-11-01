/**
 * F8 do turno da IA: ferramentas que chamam a equipe (ADR-0006, fatia S6).
 *
 * Ferramentas MOVIDAS de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * texto, ordem ou número de awaits: `request_human_handoff`, `open_human_case` e `provide_case_update`. Cada `criar*` recebe por parâmetro o que a
 * closure lia do escopo do turno; o que ela escrevia vai no `EstadoDoTurno` (o mesmo
 * objeto do orquestrador). Quando cada uma entra no turno continua decidido lá.
 */
import { tool } from '../../../edge/llm/run-model-call';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import { avisarLeadDaEscalacao } from '../../aviso-de-escalacao';
import { applyRequestHumanHandoff, buildHandoffSummary, validarPayloadDoHandoff } from '../../human-handoff';
import { openCase, openHumanCaseInputSchema, provideCaseUpdate, provideCaseUpdateInputSchema } from '../../human-cases';
import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import type { carregarContextoDoTurno } from '../contexto';
import type { tratarDesviosDeterministicos } from '../desvios-deterministicos';
import type { SaidaDoRoteamento } from '../roteamento';
import type { EstadoDoTurno } from '../estado-do-turno';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { AGENT_TOOL_DEFS } from '../../inbound-turn';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;
type SaidaDosDesvios = Extract<Awaited<ReturnType<typeof tratarDesviosDeterministicos>>, { seguir: true }>['valor'];

// F4-06: handoff humano acionado pelo PRÓPRIO modelo (cidadão de 1ª classe). MUTANTE
// (seta force_human no CRM + cancela crons + inbox), fora de READ_ONLY_TOOLS. tenant/
// lead/conversation vêm da ROW do job (closure), nunca do payload do modelo.
export function criarRequestHumanHandoff(
  c: ContextoDoTurno,
  r: { pararDigitando: () => void; avisoDaEscalacao: SaidaDosDesvios['avisoDaEscalacao']; previous: SaidaDoContexto['previous']; inboundsPendentes: SaidaDosDesvios['inboundsPendentes']; noteRunError: (err: Error) => void },
  estado: EstadoDoTurno,
) {
  const { pool, input, tenantId, leadId, runLog } = c;
  const { pararDigitando, avisoDaEscalacao, previous, inboundsPendentes, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.request_human_handoff,
    execute: async (raw) => {
      // Payload recusado não passa a conversa: valida ANTES de avisar o lead, senão
      // ele ouve "já estou chamando alguém da equipe" e ninguém é chamado.
      const payload = validarPayloadDoHandoff(raw);
      if (!payload.ok) return payload;
      estado.passouParaAEquipe = true;
      // A conversa vai para a equipe: o robô não fala mais neste turno. O aviso
      // do piso logo abaixo sai pelo canal SEM passar pelos `send` que param a
      // renovação — sem esta linha o "digitando…" reacendia DEPOIS do "vou te
      // passar para a equipe", até o `finally`.
      pararDigitando();
      try {
        // ═══ O PISO: se o modelo não falou, o sistema fala ═══
        //
        // A descrição da tool manda avisar o lead ANTES de chamá-la, e a
        // mensagem de retorno repete. Mas capacidade que depende de o modelo
        // LEMBRAR é capacidade que não existe metade das vezes — a mesma
        // conclusão que fez `expectativaDeAtendimento` parar de esperar que
        // ele consultasse a disponibilidade sozinho.
        //
        // `seq` é o contador de mensagens FÍSICAS já enviadas neste turno. Zero
        // significa: o modelo decidiu passar a conversa sem dizer nada a
        // ninguém — e depois desta tool ele não consegue mais falar, porque
        // `force_human` arma o `stopGate`. Então o aviso determinístico sai
        // AGORA, antes do handoff.
        //
        // `seq > 0` significa que ele JÁ falou neste turno; mandar o aviso ali
        // em cima seria o robô dizendo duas vezes a mesma coisa, com palavras
        // diferentes. Confiamos na fala dele e registramos que o piso não foi
        // preciso.
        const aviso =
          estado.seq === 0
            ? await avisarLeadDaEscalacao(pool, avisoDaEscalacao().ids, {
                ...avisoDaEscalacao().base,
                motivo: 'pediu_humano',
              })
            : ({ avisado: true } as const);
        // O contexto do TURNO vai junto, e sai da closure: `previous` é o
        // checkpoint durável e `inboundsPendentes` é o que o cliente disse e
        // ainda não foi respondido — os dois já estão em memória, então o
        // briefing enriquecido não custa uma consulta a mais.
        const res = await applyRequestHumanHandoff(
          pool,
          { tenantId, leadId, conversationId: input.conversationId },
          {
            conversationSummary: buildHandoffSummary(previous),
            contextoDoTurno: { checkpoint: previous, pendentesDoCliente: inboundsPendentes },
            avisoAoLead: aviso,
            // #2210: com a mensagem na mão o handoff pergunta ao banco se a
            // derivação da mídia ainda estava em aberto — e aí grava a marca
            // que permite devolver o atendimento sozinho quando o texto chegar.
            gatilho: { inboundMessageId: input.inboundMessageId },
            log: runLog,
          },
          raw,
        );
        if (!res.ok) return res; // erro de ensino (payload fora da whitelist)
        return { ok: true, status: res.status, message: res.message };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao acionar o handoff humano — encerre o turno agora.',
          },
        };
      }
    },
  });
}

export function criarOpenHumanCase(
  c: ContextoDoTurno,
  r: { agentConfig: Exclude<SaidaDoRoteamento['agentConfig'], null>; buildCaseContextSnapshot: () => Record<string, unknown>; moverParaHandoffBestEffort: (reason: string) => void; noteRunError: (err: Error) => void },
  estado: EstadoDoTurno,
) {
  const { pool, input, tenantId } = c;
  const { agentConfig, buildCaseContextSnapshot, moverParaHandoffBestEffort, noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.open_human_case,
    execute: async (raw) => {
      const parsed = openHumanCaseInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'campos do caso inválidos — informe title, summary e blocker (texto).',
          },
        };
      }
      try {
        const res = await openCase(
          pool,
          { tenantId, conversationId: input.conversationId, agentId: agentConfig.agentId },
          { ...parsed.data, contextSnapshot: buildCaseContextSnapshot() },
        );
        if (!res.ok) return res;
        estado.openedCaseThisTurn = true;
        moverParaHandoffBestEffort('open_human_case');
        // ACH-03: a expectativa vai junto com a confirmação. Medido num turno
        // real: o agente abria o caso e prometia ao cliente que "alguém entra
        // em contato" sem nunca ter olhado se havia alguém — a capacidade de
        // consultar existia, estava ligada e montada no turno, e ele não a
        // usou. Capacidade que depende de o modelo lembrar não existe metade
        // das vezes; esta o sistema garante.
        const { frase } = await expectativaDeAtendimento(pool, tenantId, new Date());
        return {
          ok: true,
          case_id: res.caseId,
          message: `caso aberto; continue a conversa com o lead normalmente. ${frase}`,
        };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao abrir o caso — encerre o turno.',
          },
        };
      }
    },
  });
}

export function criarProvideCaseUpdate(
  c: ContextoDoTurno,
  r: { noteRunError: (err: Error) => void },
) {
  const { pool, input, tenantId } = c;
  const { noteRunError } = r;
  return tool({
    ...AGENT_TOOL_DEFS.provide_case_update,
    execute: async (raw) => {
      const parsed = provideCaseUpdateInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'invalid_payload', message: 'informe case_id e info (texto).' },
        };
      }
      try {
        const res = await provideCaseUpdate(
          pool,
          { tenantId, conversationId: input.conversationId },
          { caseId: parsed.data.case_id, info: parsed.data.info },
        );
        if (!res.ok) return res;
        return {
          ok: true,
          message: 'informação enviada ao responsável; aguarde o retorno pelo caso.',
        };
      } catch (err) {
        noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'erro interno ao atualizar o caso — encerre o turno.',
          },
        };
      }
    },
  });
}
