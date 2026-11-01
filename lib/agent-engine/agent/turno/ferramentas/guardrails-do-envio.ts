/**
 * F8 do turno da IA: a cadeia de guardrails do `send_message` e os fail-safes de veto (ADR-0006, fatia S7).
 *
 * MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra, texto ou ordem.
 * O que a closure lia do escopo do turno chega por parâmetro; o que ela escrevia vai no
 * `EstadoDoTurno` (o MESMO objeto do orquestrador, nunca um campo copiado por valor).
 */
import type { criarConferidorDeAfirmacoes } from '@/lib/ai/decisao/afirmacao-de-fato';
import { runBeforeSend } from '../../../guardrails/before-send';
import type { decidePromise } from '../../../guardrails/promise/engine';
import type { loadChannelKnobs } from '../../../pacing/store';
import type { esperarComoHumano } from '../../atraso-humano';
import type { FotoParaEnvio } from '../../fotos-do-produto';
import { hasOpenCaseForContact, openCase } from '../../human-cases';
import type { ContextoDoTurno, SaidaDosPortoes } from '../portoes-de-entrada';
import type { SaidaDoRoteamento } from '../roteamento';
import type { SaidaDosDesvios } from '../desvios-deterministicos';
import type { EstadoDoTurno } from '../estado-do-turno';
import { montarArgumentosDoEnvio } from './argumentos-do-envio';
import { responderAoDesfecho } from './resposta-do-envio';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { MAX_VETOS_DE_AFIRMACAO_CLINICA, MAX_VETOS_DE_VOCABULARIO_INTERNO } from '../../inbound-turn';

/** O que o envio lê do escopo do turno. Setas = valor lido na hora da chamada. */
export interface DependenciasDoEnvio {
  agentConfig: SaidaDoRoteamento['agentConfig'];
  agentOperation: SaidaDoRoteamento['agentOperation'];
  liveChannel: SaidaDosDesvios['liveChannel'];
  optedOutThisTurn: SaidaDosDesvios['optedOutThisTurn'];
  lgpd: SaidaDosDesvios['lgpd'];
  mensagemDoJob: SaidaDosDesvios['mensagemDoJob'];
  camadas: SaidaDosPortoes['camadas'];
  maxSendsPerTurn: number;
  promiseTable: Parameters<typeof decidePromise>[0]['table'] | null;
  semanticClassifier: NonNullable<Parameters<typeof runBeforeSend>[0]['classifyPromiseSemantic']> | undefined;
  conferirAfirmacoes: ReturnType<typeof criarConferidorDeAfirmacoes>;
  knobsDeAtrasoHumano: NonNullable<Parameters<typeof esperarComoHumano>[0]['knobs']>;
  pacingDoTurno: Awaited<ReturnType<typeof loadChannelKnobs>> | null;
  inicioDoProcessamento: number;
  // `pararDigitando` é reatribuído no orquestrador; `followupDisponivel` lê `rawTools` na hora.
  pararDigitando: () => void;
  followupDisponivel: () => boolean;
  buildCaseContextSnapshot: () => Record<string, unknown>;
  moverParaHandoffBestEffort: (reason: string) => void;
  noteRunError: (err: Error) => void;
}

export async function executarCadeiaDoEnvio(
  c: ContextoDoTurno,
  r: DependenciasDoEnvio,
  estado: EstadoDoTurno,
  envio: { body: string; produto_codigo?: string; fotosDoProduto: FotoParaEnvio[]; fotosQueFaltaram: number },
) {
  const { pool, input, tenantId, runLog } = c;
  const { agentConfig, buildCaseContextSnapshot, moverParaHandoffBestEffort, noteRunError } = r;
  const { body, produto_codigo, fotosDoProduto, fotosQueFaltaram } = envio;
  // Cadeia de guardrails (F2-13): stop/opt-out → anti-ban → spinning rodam
  // AQUI, entre a decisão do modelo e o adapter. Se um gate veta, o
  // channel.send NÃO acontece e a razão volta ao modelo como erro instrutivo;
  // seq só avança quando o envio é de fato tentado (gate veto não gasta seq
  // — preserva o alinhamento (job_id, seq) do ledger F2-06 entre re-runs).
  try {
    // Wave 4 (spec 15 §10.2): estado de caso lido FRESCO a cada tentativa de envio
    // (pode ter mudado dentro deste MESMO turno via open_human_case, chamado antes
    // deste send_message). casesEnabled false (tela não habilita) → sempre false,
    // sem query — o casePromiseGate já é no-op nesse caso de qualquer forma.
    const hasOpenCase =
      agentConfig?.casesEnabled === true
        ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
        : false;
    // Args reusados EXATAMENTE (mesmo objeto) no re-run do fail-safe abaixo — só
    // hasOpenCase/openedCaseThisTurn mudam depois do auto-abre-caso.
    const beforeSendArgs = montarArgumentosDoEnvio(c, r, estado, { body, hasOpenCase, fotosDoProduto });
    let chain = await runBeforeSend(beforeSendArgs);
    if (chain.status === 'vetoed' && chain.code === 'case_promise_without_case') {
      // Wave 4 — fail-safe da invariante sagrada: o lead NUNCA recebe promessa-de-
      // humano sem caso aberto. 1ª vez no turno: erro-de-ensino (o modelo re-tenta —
      // abre o caso OU reformula sem prometer humano). Persistiu (2ª vez): o SISTEMA
      // abre um caso mínimo e libera o envio — nunca deixa a promessa passar sem caso.
      estado.vetos.casePromise += 1;
      if (estado.vetos.casePromise < 2) {
        return { ok: false, error: { code: chain.code, message: chain.message } };
      }
      const auto = await openCase(
        pool,
        {
          tenantId,
          conversationId: input.conversationId,
          agentId: agentConfig?.agentId ?? null,
        },
        {
          title: 'Atendimento que precisa de um humano',
          summary: body, // a mensagem-promessa que a IA tentou enviar
          blocker:
            'Aberto automaticamente: a IA prometeu envolver um humano e não abriu o caso (fail-safe do guardrail).',
          source: 'guardrail_autofallback',
          contextSnapshot: buildCaseContextSnapshot(),
        },
      );
      if (!auto.ok) {
        // openCase falhou (ex.: já existe outro caso aberto por corrida) — NÃO envie
        // prometendo humano sem caso; mantém a invariante com o erro de ensino original.
        return { ok: false, error: { code: chain.code, message: chain.message } };
      }
      estado.openedCaseThisTurn = true;
      moverParaHandoffBestEffort('case_promise_autofallback');
      // Re-roda a cadeia INTEIRA agora que há caso aberto — o send real acontece
      // DENTRO do runBeforeSend (via args.send); nunca chamamos o canal por fora
      // (perderia pacing/lgpd/stop). ponytail: re-roda a cadeia inteira no fail-safe
      // (raro) — pode reaplicar 1 espera de pacing; aceitável pelo caminho ser
      // excepcional.
      chain = await runBeforeSend({
        ...beforeSendArgs,
        hasOpenCase: true,
        openedCaseThisTurn: true,
      });
    }
    if (chain.status === 'vetoed' && chain.code === 'clinical_claim') {
      // Fail-safe do gate de afirmação clínica. Ao contrário do vocabulário interno,
      // este NUNCA solta o envio: não existe "frase com diagnóstico, mas melhor que
      // silêncio". O que muda na insistência é que o sistema chama a equipe — abre um
      // caso com a frase barrada — e o erro devolvido ao modelo passa a dizer que a
      // equipe foi acionada, para ele avisar a pessoa sem repetir a afirmação. A
      // resposta seguinte passa pelo `case_promise` porque o caso agora existe.
      estado.vetos.clinicalClaim += 1;
      if (
        estado.vetos.clinicalClaim >= MAX_VETOS_DE_AFIRMACAO_CLINICA &&
        agentConfig?.casesEnabled === true &&
        !estado.openedCaseThisTurn &&
        !hasOpenCase
      ) {
        const auto = await openCase(
          pool,
          {
            tenantId,
            conversationId: input.conversationId,
            agentId: agentConfig?.agentId ?? null,
          },
          {
            title: 'Pergunta clínica que precisa de um profissional',
            summary: body, // a mensagem que o assistente tentou enviar e foi barrada
            blocker:
              'Aberto automaticamente: o assistente insistiu numa afirmação clínica ' +
              '(diagnóstico, remédio, promessa de resultado ou câncer) e o envio foi barrado.',
            source: 'guardrail_autofallback',
            contextSnapshot: buildCaseContextSnapshot(),
          },
        );
        if (auto.ok) {
          estado.openedCaseThisTurn = true;
          moverParaHandoffBestEffort('clinical_claim_autofallback');
          return {
            ok: false,
            error: {
              code: chain.code,
              message:
                'A mensagem continua barrada. A equipe já foi acionada: diga à pessoa, ' +
                'em uma frase, que um profissional da equipe vai falar com ela, sem ' +
                'repetir nada sobre diagnóstico, remédio ou resultado.',
            },
          };
        }
      }
      return { ok: false, error: { code: chain.code, message: chain.message } };
    }
    if (chain.status === 'vetoed' && chain.code === 'internal_vocabulary_leak') {
      // Fail-safe do gate de vazamento — O CLIENTE NUNCA FICA SEM RESPOSTA.
      //
      // Este gate é REDE, não invariante sagrada (ao contrário do case_promise, cuja
      // 2ª camada ABRE o caso antes de liberar). Aqui não há o que o sistema possa
      // fazer no lugar do modelo: ou ele reescreve, ou a escolha é entre uma frase
      // com um termo técnico e o silêncio. Silêncio é pior — some com o atendimento
      // sem sintoma, que é o oposto do invariante 4 do sistema vivo. Então: 1º veto
      // ensina (o modelo re-tenta); persistiu, o envio sai DESARMANDO só este gate —
      // todos os outros continuam valendo, porque o re-run passa pela cadeia inteira.
      //
      // O veto da 1ª tentativa já virou linha em `before_send_traces` (com a
      // categoria do vazamento) e atividade na timeline: a liberação não apaga a
      // medição, que é o produto deste gate.
      estado.vetos.internalVocabulary += 1;
      if (estado.vetos.internalVocabulary < MAX_VETOS_DE_VOCABULARIO_INTERNO) {
        return { ok: false, error: { code: chain.code, message: chain.message } };
      }
      runLog.warn(
        'fail-safe do gate de vocabulário interno: envio liberado após vetos seguidos',
        {
          vetos: estado.vetos.internalVocabulary,
        },
      );
      // `openedCaseThisTurn` vai pelo valor VIVO (o fail-safe de casos acima pode
      // tê-lo mudado); reusar o do objeto capturado re-vetaria no case_promise.
      chain = await runBeforeSend({
        ...beforeSendArgs,
        openedCaseThisTurn: estado.openedCaseThisTurn,
        hasOpenCase: hasOpenCase || estado.openedCaseThisTurn,
        enforceInternalVocabulary: false,
      });
    }
    if (chain.status === 'vetoed') {
      // Cap de warm-up/diário: reescrever o texto não resolve (é rate limit, não
      // conteúdo) — ensinar o modelo a "tentar de novo" só gasta passo. Guardamos
      // pra reagendar o JOB inteiro depois que o turno terminar (mesmo padrão de
      // `rescheduleJob` já usado pra janela horária), em vez de deixar o lead sem
      // resposta até a próxima mensagem dele chegar (ou nunca).
      if (
        (chain.code === 'warmup_cap' || chain.code === 'daily_cap') &&
        chain.nextAllowedAt !== undefined
      ) {
        estado.pacingCapVeto = { code: chain.code, nextAllowedAt: chain.nextAllowedAt };
      }
      // Erro de ENSINO pt-br (mesmo shape de get_lead_context/breaker): o
      // modelo o vê no turno seguinte. NÃO é exceção — não derruba o run.
      return { ok: false, error: { code: chain.code, message: chain.message } };
    }
    const outcome = chain.outcome;
    estado.outcomes.push(outcome);
    // MEMÓRIA DE DUPLICATA: só o que saiu de fato vira referência para a régua.
    // sent/already_sent/queued = o corpo (ou quase) chegou/chegará ao cliente;
    // blocked/failed/unavailable não é resposta — não deve suprimir a próxima.
    // `promover` = transição exatamente uma vez: sai de `emVoo` e entra em
    // `aceitos` (o `finally` depois disso é no-op nesta candidata).
    if (outcome.kind === 'sent' || outcome.kind === 'already_sent' || outcome.kind === 'queued') {
      estado.dupTrava.promover(body);
    }
    if (outcome.kind === 'sent' && estado.pendingCitations.length > 0) {
      try {
        await pool.query(
          `update messages
                 set metadata = coalesce(metadata, '{}'::jsonb)
                   || jsonb_build_object('citations', $3::jsonb, 'ai_generated', true)
                 where organization_id = $1 and id = $2`,
          [tenantId, outcome.messageId, JSON.stringify(estado.pendingCitations)],
        );
      } catch (err) {
        // citação é enriquecimento, não invariante — falha só loga.
        runLog.warn('citações não anexadas à outbound', {
          message_id: outcome.messageId,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
        });
      }
      estado.pendingCitations = [];
    }
    return responderAoDesfecho(outcome, { produto_codigo, fotosDoProduto, fotosQueFaltaram, noteRunError });
  } catch (err) {
    // bug de programação no adapter: ensina o modelo a encerrar E derruba o job.
    noteRunError(err instanceof Error ? err : new Error(String(err)));
    return {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'erro interno no envio — encerre o turno agora.',
      },
    };
  } finally {
    // LIBERAÇÃO (#2996, item 6): toda tentativa que reservou termina aqui.
    // Sucesso já promoveu (saiu de `emVoo` dentro de `promover` — este
    // `liberar` é no-op); veto, blocked/failed/unavailable, exception e
    // timeout saem de `emVoo` sem virar memória. Nenhuma reserva sobrevive
    // à tentativa, então nada fica preso "em voo" suprimindo re-tentativas
    // legítimas.
    estado.dupTrava.liberar(body);
  }
}
