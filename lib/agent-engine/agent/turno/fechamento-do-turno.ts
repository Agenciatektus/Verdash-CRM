/**
 * F12 do turno da IA: fechamento e checkpoint (ADR-0006, fatia S9).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: fita do turno em texto, saída do assistido,
 * agenda relida, `fecharOTurno` (chamada de checkpoint, com uma correção), saída da
 * prévia e a gravação do checkpoint. As duas saídas viram `seguir: false`.
 */
import { runModelCall, type ModelMessage } from '../../edge/llm/run-model-call';
import { agendaNoFechamento } from '../abertura/agenda-no-fechamento';
import { CHECKPOINT_INSTRUCTION, fecharOTurno, insertCheckpoint } from '../abertura/checkpoint';
import { latestCheckpoint } from '../inbound-turn';
import { pruneToolResults, toolPartsAsText } from '../prune-tool-results';
import type { carregarContextoDoTurno } from './contexto';
import type { ContextoDoTurno, Passo } from './portoes-de-entrada';
import type { prepararContextoDoTurno } from './preparo-do-contexto';
import type { SaidaDoRoteamento } from './roteamento';

export interface EntradaDoFechamento {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  system: Awaited<ReturnType<typeof carregarContextoDoTurno>>['system'];
  openingTextOnly: ModelMessage[];
  compromissosBlock: Awaited<ReturnType<typeof prepararContextoDoTurno>>['compromissosBlock'];
  mensagensDoTurno: ModelMessage[];
}

export async function fecharOTurnoComCheckpoint(c: ContextoDoTurno, r: EntradaDoFechamento) {
  const { deps, job, pool, preview, tenantId, leadId, clock, runLog, liveJob } = c;
  const { agentConfig, system, openingTextOnly, compromissosBlock, mensagensDoTurno } = r;

  // F3-10: poda os tool results antigos da fita do run ANTES de reenviá-los no fechamento
  // (é onde a fita inteira é re-serializada num prompt) — o conteúdo durável já foi para
  // lead_notes pelo flush (F3-07), então o stub não perde nada recuperável. Opera SÓ no
  // sufixo por-lead, nunca no prefixo estável (regra de cache 15).
  // No SDK atual, response.messages contém só a ÚLTIMA etapa. O fechamento
  // precisa da fita inteira, incluindo as ações concluídas em etapas anteriores.
  // O fechamento vai SEM `tools`: as partes de ferramenta viram texto (a Anthropic recusa
  // tool_use/tool_result sem tools), com teto por resultado no knob do pruning.
  const responseMessages = toolPartsAsText(
    deps.knobs.prune !== undefined
      ? pruneToolResults(mensagensDoTurno, deps.knobs.prune)
      : mensagensDoTurno,
    deps.knobs.prune?.minResultTokens,
  );

  // Fechamento imposto pelo runtime: 2ª chamada, mesma conversa, só o checkpoint.
  //
  // Também sob o handoff (o do turno inteiro, em `runAgentTurn`): o teto pode
  // ser cruzado ENTRE as duas chamadas — a primeira é que gasta o grosso do
  // turno. Aqui o lead já recebeu resposta, mas a conversa ficaria sem
  // checkpoint e sem dono, e o próximo inbound cairia no mesmo bloqueio, agora
  // sem nada tendo mudado no meio.
  // Prévia sem candidato e sem impedimento: quem opera precisa saber que o agente não propôs nada.
  const avisarSemCandidato = (p: NonNullable<typeof preview>): void => {
    if (p.result.candidates.length === 0 && p.result.impediments.length === 0)
      p.result.impediments.push({
        code: 'no_candidate',
        message: 'O agente não propôs uma resposta. Revise o cenário ou a configuração.',
      });
  };
  // ⚠️ RASCUNHO (modo assistido) não fecha o turno com checkpoint. O checkpoint
  // da prévia não é gravado (a prévia retorna antes do `insertCheckpoint`, logo
  // abaixo) e o `reply-drafts.ts` não o lê — só a prévia de TESTE (sandbox) o
  // mostra na tela. Mesmo assim, a chamada de fechamento segurava a entrega do
  // rascunho: medido em produção (gpt-6-luna, 2026-09-24), resposta pronta às
  // 12:32:40 e rascunho entregue às 12:32:56 — 16 dos 28 s que o operador
  // esperava depois de clicar em "Sugerir resposta".
  if (preview?.kind === 'assisted') {
    avisarSemCandidato(preview);
    return { seguir: false, motivo: 'rascunho_do_assistido' } as const;
  }
  // A prévia propõe escritas: não pode tratá-las como reservas executadas.
  let agendaAtual = '';
  if (!preview) {
    try {
      agendaAtual = await agendaNoFechamento({
        db: pool,
        organizationId: tenantId,
        contactId: leadId,
        agora: clock(),
        blocoDaAbertura: compromissosBlock,
        mensagens: mensagensDoTurno,
      });
    } catch (err) {
      // A resposta já saiu: falhar o job por esta leitura repetiria o turno.
      // Falha de leitura não equivale a agenda vazia nem a ação desfeita.
      runLog.warn('agenda não pôde ser relida no fechamento', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
      agendaAtual = 'A agenda não pôde ser relida depois das ações deste turno. Isso não prova ausência de reserva nem desfaz uma ação concluída. Registre somente o que os resultados das ferramentas comprovaram.';
    }
  }
  // Uma correção antes de re-tentar o turno inteiro (`fecharOTurno`): o JSON
  // recusado volta ao modelo com o problema, numa 2ª chamada de fechamento.
  const { content, resposta: closing } = await fecharOTurno({
    pedir: async (correcao) => {
      const chamada = await runModelCall(
        pool,
        deps.llmCfg,
        {
          tenantId,
          leadId: leadId || null,
          jobId: job?.id,
          purpose: 'checkpoint',
          ...(agentConfig !== null
            ? {
                model: agentConfig.model,
                llmOverride: {
                  provider: agentConfig.provider,
                  credentialId: agentConfig.credentialId,
                },
              }
            : {}),
          system,
          messages: [
            // prune: o checkpoint reusa a abertura só como texto — a mídia nativa (cara) já
            // fez seu trabalho na 1ª chamada e não precisa ir de novo.
            ...openingTextOnly,
            ...responseMessages,
            ...(agendaAtual ? [{ role: 'user' as const, content: agendaAtual }] : []),
            { role: 'user', content: CHECKPOINT_INSTRUCTION },
            ...correcao,
          ],
        },
        { registry: deps.registry, log: runLog },
      );
      return { text: chamada.result.text, callId: chamada.callId };
    },
    ajustar: (text) =>
      text.replace(/https:\/\/meet\.google\.com\/[a-zA-Z0-9-]+/g, '[link da reunião disponível na Agenda]'),
    log: runLog,
  });

  if (preview) {
    preview.result.checkpoint = content;
    avisarSemCandidato(preview);
    return { seguir: false, motivo: 'previa' } as const;
  }

  // Wave 3 (2.4): o checkpoint anterior é lido ANTES de gravar o novo — a
  // timeline recebe o DIFF, nunca o snapshot. Emitir a cada turno encheria a
  // tela com "a IA pensou" e enterraria a única linha que muda o que alguém
  // faria a seguir.
  const checkpointAnterior = await latestCheckpoint(pool, tenantId, leadId);
  await insertCheckpoint(pool, { tenantId, leadId, jobId: liveJob().id, content });

  return { seguir: true, valor: { content, closing, checkpointAnterior } } as const satisfies Passo<unknown>;
}
