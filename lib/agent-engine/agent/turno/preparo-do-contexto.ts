/**
 * F6 do turno da IA: o preparo do contexto (ADR-0006, fatia S5).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits. Prepara o roteiro de atendimento, roda a
 * compactação (com o flush que grava notas), lê em paralelo notas, compromissos e
 * origem, e cancela os follow-ups do contato bloqueado. Não tem saída antecipada.
 */
import { cancelPendingCronsForLead } from '../../cron/scheduler';
import type { LeadCheckpointRow } from '../abertura/checkpoint';
import { buildOrigemBlock } from '../abertura/origem-do-contato';
import { maybeCompact, renderCompactedSummary, trimTranscriptToBudget } from '../compaction';
import { buildCompromissosBlock } from '../compromissos-do-contato';
import { validarRespostaDoFluxo } from '../flow-validate';
import { buildNotesIndexBlock } from '../lead-notes';
import { prepararRoteiroDoTurno } from '../roteiro-no-turno';
import { moduloLigadoComMemo } from '@/lib/instalacao/modulos';
import type { carregarContextoDoTurno } from './contexto';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;

/** O que F3, F4 e F5 entregam a F6. */
export interface EntradaDoPreparo {
  routed: SaidaDoRoteamento['routed'];
  argsAux: SaidaDoContexto['argsAux'];
  currentInboundText: SaidaDoContexto['currentInboundText'];
  previous: SaidaDoContexto['previous'];
  openingContext: SaidaDoContexto['openingContext'];
  optedOutThisTurn: boolean;
}

export async function prepararContextoDoTurno(c: ContextoDoTurno, e: EntradaDoPreparo) {
  const { deps, job, pool, input, preview, tenantId, leadId, runLog, liveJob } = c;
  const { routed, argsAux, currentInboundText, previous, openingContext, optedOutThisTurn } = e;

  // ROTEIRO DE ATENDIMENTO (módulo opcional `fluxos_atendimento`, #1130). Entra
  // AQUI, depois de tudo que silencia o turno — handoff humano, pausa, pedido de
  // humano, opt-out ambíguo — e nunca para contato bloqueado. Na prova prática,
  // o roteiro começava antes dessas travas e abria para quem pedira para parar.
  // Chave desligada: `null` sem consulta nenhuma. Ver `roteiro-no-turno.ts`.
  const roteiro =
    !preview && liveJob().kind === 'inbound_turn' && !optedOutThisTurn
      ? await prepararRoteiroDoTurno(
          {
            pool,
            moduloLigado: () => moduloLigadoComMemo(deps.crmCfg.supabase, 'fluxos_atendimento'),
            validar: (args) =>
              validarRespostaDoFluxo(
                pool,
                deps.llmCfg,
                { tenantId, leadId, jobId: liveJob().id },
                args,
                { registry: deps.registry, log: runLog, aux: argsAux(undefined) },
              ),
            log: runLog,
          },
          {
            organizationId: tenantId,
            contactId: leadId,
            conversationId: input.conversationId,
            texto: currentInboundText,
            messageId: input.inboundMessageId ?? null,
            flowPointerDoRoteador: 'flowPointerId' in routed ? (routed.flowPointerId ?? null) : null,
            mensagens: openingContext.context.messages.slice(-6).map((m) => ({
              de: m.direction === 'inbound' ? ('cliente' as const) : ('loja' as const),
              texto: m.body,
            })),
          },
        )
      : null;

  // F3-07: compaction + flush pré-compaction. Quando o histórico cresce além do limiar,
  // o FLUSH grava as notas duráveis (lead_notes) e a compaction resume a conversa com o
  // modelo BARATO; o resumo compactado entra no lugar do rolling summary e o transcript
  // integral é trocado por uma cauda recente sob orçamento (regra de cache 15). O rolling
  // summary DURÁVEL segue vindo do checkpoint de fechamento; aqui ele só alimenta o prompt.
  let effectivePrevious = previous;
  let effectiveContext = openingContext.context;
  if (deps.knobs.compaction !== undefined) {
    const compacted = await maybeCompact(
      pool,
      deps.llmCfg,
      { tenantId, leadId: leadId || null, jobId: job?.id },
      {
        context: openingContext.context,
        previousSummary: previous?.rolling_summary ?? '',
        // A compactação é o QUARTO call site da mesma regra, e o #151 só cobriu
        // três: ela também pedia o modelo do agente ao provider default da org.
        // Mesmo 404, mesma morte de turno — só que num caminho que roda quando a
        // conversa já é longa, ou seja, mais tarde e com menos gente olhando.
        knobs: { ...deps.knobs.compaction, ...argsAux(deps.knobs.compaction.model) },
        notesIndexMaxTokens: deps.knobs.notesIndexMaxTokens,
      },
      {
        registry: deps.registry,
        log: runLog,
        ...(preview
          ? {
              noteSink: (note: { headline: string; body: string }) => {
                (preview.notes ??= []).push(note);
              },
            }
          : {}),
      },
    );
    if (compacted !== null) {
      // Só o rolling_summary é sobrescrito (o resumo compactado carrega compromissos/
      // objeções/estágio/dados pessoais planificados). O `previous` sintético do 1º
      // turno com histórico importado é local — nunca persistido; o fechamento grava o
      // checkpoint real.
      const base: LeadCheckpointRow = previous ?? {
        id: '',
        seq: '0',
        organization_id: tenantId,
        contact_id: leadId,
        job_id: null,
        created_at: new Date(),
        commitments: [],
        objections: [],
        next_action: null,
        rolling_summary: '',
        // Este `previous` é sintetizado a partir de histórico IMPORTADO — não
        // houve turno nosso, logo ninguém declarou nada. `null` é o valor
        // honesto; um objeto vazio afirmaria uma avaliação que não aconteceu.
        declaracao: null,
      };
      effectivePrevious = { ...base, rolling_summary: renderCompactedSummary(compacted) };
      effectiveContext = {
        ...openingContext.context,
        messages: trimTranscriptToBudget(
          openingContext.context.messages,
          deps.knobs.compaction.transcriptMaxTokens,
        ),
      };
    }
  }

  // Índice da memória durável do lead (F3-05) — headlines dentro do orçamento fixo,
  // injetado no SUFIXO da abertura (não invalida o prefixo cacheável F2-17). Montado
  // DEPOIS do flush (F3-07) para que as notas gravadas neste turno já entrem no índice.
  // As três leituras abaixo só dependem do flush, não umas das outras: correm juntas.
  //
  // ⚠️ `leadId` AQUI É O CONTATO (`leadIdDoJob = job.contact_id`, e o comentário
  // de `get-lead-context.ts:193` diz o mesmo). Passar essa variável para um
  // parâmetro chamado `contactId` é correto pelo VALOR; o nome é que mente, e é
  // o que a issue #509 conserta. Não troque por um `lead_id` "mais coerente".
  const [notesIndexBlock, compromissosBlock, origemBlock, noteIdRows] = await Promise.all([
    preview
      ? (preview.notes ?? []).map((n) => n.headline + ': ' + n.body).join('\n')
      : buildNotesIndexBlock(pool, tenantId, leadId, deps.knobs.notesIndexMaxTokens),
    preview?.kind === 'sandbox' ? '' : buildCompromissosBlock(pool, tenantId, leadId, new Date()),
    // Só o turno que responde ao contato recebe o bloco completo; follow-up e caso,
    // em que não há texto-padrão do botão a responder, recebem o histórico curto.
    preview
      ? ''
      : buildOrigemBlock(pool, tenantId, leadId, new Date(), liveJob().kind === 'inbound_turn' ? 'entrada' : 'retomada'),
    preview
      ? null
      : pool
          .query<{ id: string }>(
            'select id from lead_notes where organization_id = $1 and contact_id = $2 order by created_at',
            [tenantId, leadId],
          )
          .then((r) => r.rows),
  ]);
  // Observabilidade da memória (Fase 2A): SÓ ids/contagens no log — headline/corpo
  // são PII e nunca saem do prompt. Prova auditável de que a memória durável do
  // lead entrou no contexto DESTE turno.
  if (noteIdRows !== null) {
    runLog.info('memória do lead injetada no turno', {
      checkpoint_seq: effectivePrevious?.seq ?? null,
      notes_count: noteIdRows.length,
      note_ids: noteIdRows.map((r) => r.id),
    });
  }

  // F4-07: STOP no CRM detectado no turno → cancela TODOS os follow-ups agendados do lead
  // (não só o job atual). O stopGate já veta ESTE turno; o cancel garante que nenhum cron
  // futuro dispare em vão (opt-out irrevogável, regra dura nº 2). Idempotente — reusa o
  // cancel compartilhado com o handoff (F4-06).
  if (!preview && optedOutThisTurn) {
    const canceled = await cancelPendingCronsForLead(pool, tenantId, leadId);
    if (canceled > 0) {
      runLog.info('opt-out detectado no turno — follow-ups agendados cancelados', { canceled });
    }
  }

  return { roteiro, effectivePrevious, effectiveContext, notesIndexBlock, compromissosBlock, origemBlock };
}
