/**
 * F9 do turno da IA, segunda parte: os classificadores auxiliares (ADR-0006, fatia S8).
 *
 * Código MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra,
 * ordem, texto de log ou número de awaits: estágio, jailbreak e o Jev no MESMO
 * `Promise.all` (cerca `classificadores-auxiliares-em-paralelo`), a gravação do Jev
 * e o nível final da manipulação. Sem saída antecipada; o teto de orçamento segue
 * subindo daqui como subia do corpo do turno.
 */
import type { ToolSet } from '../../edge/llm/run-model-call';
import { textoDoClienteNaUltimaMensagem } from '../../edge/crm/get-lead-context';
import { camadaLigada } from '../../guardrails/camadas-da-org';
import { classifyJailbreak, type JailbreakLevel } from '../../guardrails/jailbreak/classifier';
import { classificadoresDoTurno } from '../classificadores-do-turno';
import type { LeadStage } from '../lead-state';
import { classifyStage, renderStageHint } from '../stage-classifier';
import {
  nivelFinalDaManipulacao,
  perguntarManipulacaoAoJev,
  registrarManipulacaoDoJev,
  type ManipulacaoDoJev,
} from '@/lib/ai/decisao/manipulacao';
import type { carregarContextoDoTurno } from './contexto';
import type { ContextoDoTurno, SaidaDosPortoes } from './portoes-de-entrada';
import type { prepararContextoDoTurno } from './preparo-do-contexto';

type SaidaDoContexto = Awaited<ReturnType<typeof carregarContextoDoTurno>>;
type SaidaDoPreparo = Awaited<ReturnType<typeof prepararContextoDoTurno>>;

export interface EntradaDosClassificadores {
  camadas: SaidaDosPortoes['camadas'];
  argsAux: SaidaDoContexto['argsAux'];
  leadState: SaidaDoContexto['leadState'];
  effectivePrevious: SaidaDoPreparo['effectivePrevious'];
  effectiveContext: SaidaDoPreparo['effectiveContext'];
  /** As ferramentas do engine depois da montagem (o estágio só roda com `update_lead_state`). */
  rawTools: ToolSet;
  /** A última inbound do lead (`latestInboundSignal`). */
  skillSignal: string;
}

export async function classificarOTurno(c: ContextoDoTurno, r: EntradaDosClassificadores) {
  const { deps, pool, job, input, preview, tenantId, leadId, runLog } = c;
  const { camadas, argsAux, leadState, effectivePrevious, effectiveContext, rawTools, skillSignal } = r;

  // F3-11: stage-classifier auxiliar. Roda ANTES do turno (modelo BARATO pelo seam
  // agnóstico) e sugere o estágio; a sugestão entra como HINT no SUFIXO por-lead — o modelo
  // do agente decide e confirma via update_lead_state (a máquina F2-10 é a única porta). A
  // sugestão fica guardada para comparar com o que o modelo confirmou (divergência, no fim).
  const currentStage: LeadStage = leadState?.stage ?? 'new';
  let stageSuggestion: LeadStage | null = null;
  let stageHintBlock = '';
  let jailbreakLevel: JailbreakLevel = 'none';

  // Os dois classificadores auxiliares rodam EM PARALELO, e não em série.
  //
  // Eles são ADVISÓRIOS, leem sinais diferentes (o contexto e o estágio atual
  // vs. a última mensagem do lead) e nenhum consome o resultado do outro — em
  // série o turno pagava duas idas-e-voltas de LLM uma atrás da outra, e o
  // cliente esperava a soma. `Promise.all` paga só a mais lenta das duas.
  //
  // O que NÃO muda por rodar junto: o orçamento mensal da organização é
  // checado dentro de cada `runModelCall` (a mesma checagem que já corre
  // concorrente entre turnos de leads diferentes), nenhuma decisão de
  // guardrail depende de ordem entre os dois, e o `jailbreak` segue sem vetar
  // o inbound — só flagra o turno no trace.
  //
  // A TERCEIRA perna é o Jev na mesma pergunta do jailbreak
  // (`lib/ai/decisao/manipulacao.ts`), e só existe onde ela tem com quem
  // comparar e o que medir: a camada ligada para a organização, fora da
  // prévia — simulação não vira concordância (R5) — e no turno da mensagem
  // NOVA (`inbound_turn`): o `case_reply_turn` responde a ação de um humano
  // sobre uma mensagem que o turno dela já perguntou. A tarefa desligada, o
  // interruptor e o aceite são conferidos lá dentro. Em paralelo, o turno só
  // espera por ele o que ele passar do mais lento dos dois.
  //
  // O Jev recebe o que o CLIENTE digitou, e não o `skillSignal`: numa mídia, o
  // `skillSignal` leva a transcrição, a descrição ou o texto do PDF e a moldura
  // de instrução do agente, que o aceite ("cada mensagem, sozinha") não cobre
  // (R4). Mídia fica de fora da pergunta dele.
  const manipulacaoLigada = camadaLigada(camadas.jailbreak, deps.knobs.jailbreak !== undefined);
  const perguntaAoJev =
    manipulacaoLigada && !preview && job?.kind === 'inbound_turn'
      ? perguntarManipulacaoAoJev(
          pool,
          {
            organizationId: tenantId,
            mensagem: textoDoClienteNaUltimaMensagem(effectiveContext.messages),
            contactId: leadId || null,
            jobId: job.id,
          },
          deps.jev,
        )
      : Promise.resolve(null);
  const gravarOJev = async (
    doJev: ManipulacaoDoJev | null,
    nivelDaIa: JailbreakLevel | null,
    nivelFinal: JailbreakLevel,
  ): Promise<void> => {
    if (doJev === null) return;
    await registrarManipulacaoDoJev(pool, {
      organizationId: tenantId,
      contactId: leadId || null,
      conversationId: input.conversationId || null,
      messageId: input.inboundMessageId ?? null,
      jobId: job?.id ?? null,
      jev: doJev,
      nivelDaIa,
      nivelFinal,
    });
  };
  // Só classifica quando há mensagem nova e quem use a resposta (ver
  // `classificadores-do-turno.ts`).
  const vaiClassificar = classificadoresDoTurno({
    jobKind: job?.kind ?? null,
    estagioLigado: deps.knobs.stageClassifier !== undefined,
    temQuemConfirmeOEstagio: rawTools.update_lead_state !== undefined,
    manipulacaoLigada,
    ultimaMensagemDoCliente: skillSignal,
  });
  const [stageResultado, jailbreakVerdict, manipulacaoDoJev] = await Promise.all([
    deps.knobs.stageClassifier !== undefined && vaiClassificar.estagio
      ? classifyStage(
          pool,
          deps.llmCfg,
          { tenantId, leadId: leadId || null, jobId: job?.id },
          {
            context: effectiveContext,
            currentStage,
            resumo: effectivePrevious?.rolling_summary ?? null,
            ...argsAux(deps.knobs.stageClassifier.model),
          },
          { registry: deps.registry, log: runLog },
        )
      : Promise.resolve(null),
    // F4-04: classifier ADVISÓRIO anti-jailbreak sobre a mensagem INBOUND do lead (o
    // skillSignal já é a última inbound). Roda pelo seam agnóstico (modelo BARATO, budget
    // checado nele). NÃO veta o inbound — só FLAGRA o turno no trace; flag/level não são PII
    // (a mensagem/reason nunca vão a log). A correlação com promessa fora de tabela escala no fim.
    vaiClassificar.manipulacao
      ? classifyJailbreak(
          pool,
          deps.llmCfg,
          { tenantId, leadId: leadId || null, jobId: job?.id },
          {
            message: skillSignal,
            // Knob ausente + organização ligando = roda com o modelo padrão dela,
            // que é a convenção já usada pelo stageClassifier.
            ...argsAux(deps.knobs.jailbreak?.model),
          },
          { registry: deps.registry, log: runLog },
        )
      : Promise.resolve(null),
    perguntaAoJev,
  ]).catch(async (err: unknown) => {
    // O teto de orçamento derruba o classificador de sempre (`LlmBudgetExceededError`
    // sobe para a escolta do turno), mas não o Jev (R8): a chamada dele já saiu
    // e foi cobrada, e o custo entra em `llm_calls` — a observação vai sem par,
    // porque a IA de sempre não decidiu. `perguntaAoJev` nunca rejeita.
    await gravarOJev(await perguntaAoJev, null, 'none');
    throw err;
  });

  stageSuggestion = stageResultado;
  if (stageSuggestion !== null) {
    stageHintBlock = renderStageHint(stageSuggestion, currentStage);
  }

  // Observando, vale o nível da IA de sempre; decidindo, o maior dos dois; e
  // sem veredito da IA de sempre, `none` — nunca o Jev no lugar dela (R2).
  jailbreakLevel = nivelFinalDaManipulacao(jailbreakVerdict, manipulacaoDoJev);
  if (jailbreakLevel !== 'none') {
    // trace do turno: só flag/level (não PII) — a mensagem e o reason nunca são logados.
    runLog.warn('jailbreak: sinal detectado na mensagem do lead', {
      jailbreak_flag: true,
      jailbreak_level: jailbreakLevel,
      ...(jailbreakLevel !== jailbreakVerdict?.level ? { jailbreak_somado_pelo_jev: true } : {}),
    });
  }
  await gravarOJev(
    manipulacaoDoJev,
    jailbreakVerdict === null || jailbreakVerdict.falhou ? null : jailbreakVerdict.level,
    jailbreakLevel,
  );

  return { stageSuggestion, stageHintBlock, jailbreakLevel };
}
