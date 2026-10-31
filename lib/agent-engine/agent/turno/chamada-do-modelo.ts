/**
 * F10 do turno da IA: a chamada principal do modelo (ADR-0006, fatia S9).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: `runModelCall` (turno ou prévia), detecção
 * da saída truncada, escalação por jailbreak com promessa fora da tabela e o relance
 * de `runError` e da falha de envio. Devolve `turn` e `saidaTruncada` para a correção.
 */
import { runModelCall, type ModelMessage, type ToolSet } from '../../edge/llm/run-model-call';
import { JAILBREAK_ESCALATION_LEVEL, escalateJailbreakPromise } from '../../guardrails/jailbreak/classifier';
import type { classificarOTurno } from './classificadores-auxiliares';
import type { carregarContextoDoTurno } from './contexto';
import type { EstadoDoTurno } from './estado-do-turno';
import type { ContextoDoTurno } from './portoes-de-entrada';
import type { SaidaDoRoteamento } from './roteamento';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;

export interface EntradaDaChamada {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  system: SaidaDoContexto['system'];
  maxSteps: SaidaDoContexto['maxSteps'];
  openingMessages: ModelMessage[];
  tools: ToolSet;
  jailbreakLevel: Awaited<ReturnType<typeof classificarOTurno>>['jailbreakLevel'];
}

export async function chamarOModelo(c: ContextoDoTurno, r: EntradaDaChamada, estado: EstadoDoTurno) {
  const { deps, job, pool, preview, tenantId, leadId, runLog } = c;
  const { agentConfig, system, maxSteps, openingMessages, tools, jailbreakLevel } = r;

  // O "digitando…" ENQUANTO o modelo pensa já está aceso e sendo renovado desde
  // o início do `try` (`manterDigitando`). A pausa humana antes da 1ª bolha
  // (`esperaForaDoLock`) desconta este tempo e quase sempre zera — e com espera
  // zero ela não acende presença; é a renovação que cobre o cliente até lá.

  // O modelo decide tools livremente dentro do teto de steps (knob AGENT_MAX_STEPS).
  //
  // Sem escolta LOCAL: quem cobre o teto de gasto é `runAgentTurn`, que envolve
  // este corpo inteiro. Escoltar aqui deixaria de fora as chamadas de modelo dos
  // auxiliares (`classifyStage`, `maybeCompact`), que rodam ANTES desta e por
  // isso são as que estouram primeiro.
  const turn = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId: leadId || null,
      jobId: job?.id,
      // De quem é esta execução. Vai para `llm_calls.agent_id` e é o que permite
      // a aba "Execuções" da tela do agente mostrar o que ELE fez — antes ela
      // lia `ai_agent_runs`, tabela que motor nenhum vivo escreve, e dizia
      // "Nenhuma execução ainda" com o agente respondendo no WhatsApp.
      agentId: agentConfig?.agentId ?? null,
      purpose: preview ? 'agent_preview' : 'agent_turn',
      system,
      messages: openingMessages,
      tools,
      maxSteps,
      // Rascunho: a resposta é o send_message ACEITO; a etapa seguinte só
      // "encerrava". Aceito, e não chamado: o envio vetado pela cadeia
      // before_send volta ao modelo para ele reescrever (o 1º veto ensina).
      ...(preview?.kind === 'assisted'
        ? { pararQuando: () => preview.result.candidates.length > 0 }
        : {}),
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

  // SAÍDA TRUNCADA (finish_reason = 'length'): o modelo bateu no
  // teto de tokens de saída e o que produziu veio cortado. A detecção mora aqui,
  // no ponto que consome o resultado, porque o seam devolve o resultado INTEIRO
  // (ramo generateText e ramo de assinatura streamText — este último monta o
  // objeto à mão e só não cega se repassar o finishReason, ver run-model-call).
  //
  // NUNCA se manda parcial: texto fora de `send_message` não sai, e argumento de
  // tool cortado falha no schema (zod) e nem executa. Logo, truncamento só é
  // DANO quando nada despachou — aí vira correção limitada (UM retry, o mesmo
  // caminho do turno mudo) e, se a correção também falhar, FALHA TERMINAL
  // VISÍVEL. Nunca retry infinito, nunca silêncio mascarado como decisão.
  const saidaTruncada = turn.result.finishReason === 'length';
  if (saidaTruncada) {
    runLog.warn('output_truncated — resposta do modelo cortada no teto de tokens', {
      job_id: job?.id ?? null,
      enviadas_ate_aqui: estado.outcomes.length,
      finish_reason: turn.result.finishReason,
    });
  }

  // F4-04: correlação dos dois sinais do MESMO turno — jailbreak ALTO + tentativa de
  // promessa fora de tabela (F4-01). Ambos estão determinados aqui (o jailbreak rodou na
  // abertura; as tentativas de envio já passaram pelo loop). Dispara escalação humana em
  // inbox_items (dedup por episódio). Advisório: o classifier sozinho nunca escala — o gate
  // determinístico é que confirma a promessa indevida. Feito antes do runError/veto para
  // não se perder num turno que falha o envio depois.
  if (!preview && jailbreakLevel === JAILBREAK_ESCALATION_LEVEL && estado.outOfTablePromiseAttempted) {
    const created = await escalateJailbreakPromise(pool, {
      tenantId,
      leadId,
      level: jailbreakLevel,
    });
    if (created > 0) {
      runLog.warn(
        'jailbreak: escalação humana criada (flag alta + promessa fora de tabela no turno)',
        {
          jailbreak_level: jailbreakLevel,
        },
      );
    }
  }

  if (estado.runError !== null) {
    throw estado.runError; // job falha → retry da fila; o ledger segura duplicata de envio
  }
  if (estado.outcomes.some((o) => o.kind === 'failed')) {
    // ponytail: retry re-roda o run inteiro (LLM incluso); seq N re-encontra a
    // linha do ledger — 'accepted' pula, 'failed' rotaciona a key (F2-06).
    throw new Error('envio marcado como failed pelo CRM — run re-tentado pela fila');
  }

  return { turn, saidaTruncada };
}
