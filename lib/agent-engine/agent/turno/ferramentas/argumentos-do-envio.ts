/**
 * F8 do turno da IA: os argumentos da cadeia `runBeforeSend` do `send_message` (pausa humana, bolhas e fotos) (ADR-0006, fatia S7).
 *
 * MOVIDO de `executarTurnoDoAgente` (inbound-turn.ts) sem mudança de regra, texto ou ordem.
 * O que a closure lia do escopo do turno chega por parâmetro; o que ela escrevia vai no
 * `EstadoDoTurno` (o MESMO objeto do orquestrador, nunca um campo copiado por valor).
 */
import type { ChannelSendResult } from '../../../channel-adapter';
import { claimOfJob } from '../../../queue/claim';
import { camadaLigada } from '../../../guardrails/camadas-da-org';
import { esperarComoHumano } from '../../atraso-humano';
import { sendInBubbles, splitForSend } from '../../split-message';
import { enviarComFotos, type FotoParaEnvio } from '../../fotos-do-produto';
import type { ContextoDoTurno } from '../portoes-de-entrada';
import type { EstadoDoTurno } from '../estado-do-turno';
import type { DependenciasDoEnvio } from './guardrails-do-envio';
// Valor lido só dentro das funções (nunca na carga do módulo): o ciclo de import é seguro.
import { eTurnoDeResposta, ferramentasDeAgendaDoAgente, temFerramentaDeAgenda } from '../../inbound-turn';

export function montarArgumentosDoEnvio(
  c: ContextoDoTurno,
  r: DependenciasDoEnvio,
  estado: EstadoDoTurno,
  envio: { body: string; hasOpenCase: boolean; fotosDoProduto: FotoParaEnvio[] },
) {
  const { deps, pool, input, tenantId, leadId, clock, runLog, liveJob } = c;
  const {
    agentConfig, agentOperation, liveChannel, optedOutThisTurn, lgpd, camadas, maxSendsPerTurn, semanticClassifier,
    conferirAfirmacoes, knobsDeAtrasoHumano, pacingDoTurno, inicioDoProcessamento, pararDigitando, followupDisponivel,
  } = r;
  const { body, hasOpenCase, fotosDoProduto } = envio;
  return {
    pool,
    log: runLog,
    agentOperation,
    tenantId,
    leadId,
    jobId: liveJob().id,
    channelSessionId: input.channelSessionId,
    body,
    optedOutThisTurn,
    // `inbound_turn`/`case_reply_turn` respondem a quem escreveu e leem a
    // janela de RESPOSTA (0495). `followup_turn` retoma conversa parada e
    // continua na janela de DISPARO.
    resposta: eTurnoDeResposta(liveJob()),
    // ponytail: channel_sessions.daily_message_limit do CRM ainda não é lido
    // no runtime — null cai nos degraus de warm-up (conservadores). Injetar
    // aqui quando o drain expuser o limite da sessão.
    crmDailyLimit: null,
    now: clock(),
    sleep: deps.sleep,
    lgpd,
    ...(input.conducao ? { disclosureDesde: input.conducao.aberta_em } : {}),
    casesEnabled: agentConfig?.casesEnabled ?? false,
    hasOpenCase,
    openedCaseThisTurn: estado.openedCaseThisTurn,
    // Nome(s) próprio(s) que o prompt do tenant usa pra retaguarda humana (ex.:
    // "Fulano") — o mesmo vocabulário que `matchesHandoffKeyword` já usa do lado
    // do CLIENTE, agora somado ao alvo genérico do `casePromiseGate` do lado do
    // que o MODELO promete. Ver `GateContext.humanPromiseExtraTargets`.
    humanPromiseExtraTargets: agentConfig?.handoffKeywords ?? [],
    // A rede contra vazamento de vocabulário interno arma AQUI e só aqui: este é
    // o único corpo escrito pelo MODELO, e o único caminho em que o veto vira
    // erro instrutivo que ele pode consertar no turno seguinte. O `send_template`
    // (mais acima) fica desarmado de propósito — o texto lá é do humano e já
    // aprovado pela Meta; vetá-lo devolveria ao modelo a culpa por uma frase que
    // não é dele, e a única saída seria o silêncio. O follow-up determinístico
    // idem (ver GateContext.internalVocabularyEnforced).
    enforceInternalVocabulary: true,
    // Afirmação clínica: mesma razão do vocabulário (só o corpo do MODELO), e
    // só para a organização que ligou a camada — ver
    // `GateContext.clinicalClaimEnforced`. Sem linha, desligada: não há padrão de
    // ambiente para uma proteção que só faz sentido em saúde.
    enforceClinicalClaim: camadaLigada(camadas.afirmacao_clinica, false),
    // Mesmo padrão do vocabulário interno: só o `send_message` arma — é o único
    // corpo escrito pelo modelo. `active` é ter QUALQUER ferramenta de agenda:
    // um agente que só CONSULTA promete "vou verificar" igual, e enquanto a
    // condição era só `crm_book_appointment` ele ficava sem o gate. Quem não tem
    // ferramenta de agenda nenhuma segue desarmado — vetá-lo não teria cura.
    agenda: {
      active: agentConfig !== null && temFerramentaDeAgenda(agentConfig.toolIds),
      ferramentas: agentConfig === null ? [] : ferramentasDeAgendaDoAgente(agentConfig.toolIds),
      toolCalledThisTurn: estado.agendaToolCalledThisTurn,
    },
    followup: {
      disponivel: followupDisponivel(),
      agendadoNesteTurno: estado.followupAgendadoNesteTurno,
    },
    ...(deps.knobs.disclosureMode !== undefined
      ? { disclosureMode: deps.knobs.disclosureMode }
      : {}),
    // Gate 5 (F4-02): classificador semântico roteado pelo MESMO seam agnóstico (budget
    // da org checado nele). Closure com tenant/lead/job da ROW fechados — nunca do payload.
    ...(semanticClassifier !== undefined
      ? { classifyPromiseSemantic: semanticClassifier }
      : {}),
    // Conferência de fato (#2231): só o `send_message` arma, pelo mesmo
    // motivo do vocabulário interno — é o único corpo escrito pelo
    // modelo. Um `null` devolvido (não conferido) é fail-open.
    conferirAfirmacoes,
    // Pausa humana do turno, paga FORA do lock do número (issue #654). Antes ela
    // era paga dentro do `send` logo abaixo (via `antesDaPrimeira`), e o `send`
    // só acontece com o `pg_advisory_xact_lock` do canal na mão — cada turno
    // segurava a fila do NÚMERO por 1,2s–7,5s além do necessário. Agora o
    // guardrail a paga antes de tomar conexão: sem transação aberta durante a espera.
    //
    // O texto que dimensiona a pausa é a 1ª bolha do MESMO fatiamento que o
    // `sendInBubbles` usa (`splitForSend` é a fonte única da decisão) — a pausa
    // segue proporcional ao que o cliente lê primeiro, não ao corpo todo.
    //
    // Diferença declarada: aqui o texto é o `body` PRÉ-cadeia; o `finalBody`
    // pós-disclosure só existe do lado de dentro do guardrail. Um disclosure
    // prependado pelo gate F4-05 não entra na conta da espera (antes entrava,
    // porque o gancho recebia `finalBody`).
    esperaForaDoLock: async (): Promise<void> => {
      // Uma vez por TURNO — o flag impede que um re-run do fail-safe (veto de
      // promessa/vocabulário) cobre a espera de novo do mesmo cliente.
      if (estado.jaEsperouComoHumano) return;
      estado.jaEsperouComoHumano = true;
      // A 1ª bolha vai sair: a renovação para aqui. Depois da mensagem, um
      // "digitando…" novo leria como uma segunda resposta a caminho.
      pararDigitando();
      // `liveChannel()`, não `channel`: o transporte é anulável (preview não tem
      // canal) e este é o MESMO acessor que o `send` logo abaixo usa. Resolver
      // antes da espera mantém o desfecho de preview idêntico ao de antes —
      // `preview_transport_forbidden` na hora, e não depois da pausa.
      const canal = liveChannel();
      const ms = await esperarComoHumano({
        texto:
          splitForSend(
            body,
            agentConfig?.splitMessages ?? false,
            agentConfig?.splitMaxChars ?? 600,
            Math.max(1, maxSendsPerTurn - estado.seq),
          )[0] ?? body,
        // Os quatro números do atraso por conexão (0499). Vazios (sem
        // linha em channel_knobs / preview) = defaults históricos.
        knobs: knobsDeAtrasoHumano,
        // `processamentoMs` é a contribuição do #849 (@Teowfb): a pausa humana desconta o
        // tempo que o turno JÁ gastou pensando, em vez de somar em cima dele. Sem este
        // argumento o `gasto` de `atraso-humano.ts` cai no `?? 0` e o desconto não acontece —
        // o cliente espera duas vezes. O ponto de chamada mudou de lugar com a #654 (a pausa
        // saiu de `antesDaPrimeira`, dentro do lock, para cá), e o desconto veio junto.
        processamentoMs: performance.now() - inicioDoProcessamento,
        sleep: deps.sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s))),
        log: runLog,
        ...(canal.signalTyping
          ? {
              sinalizarDigitando: (): Promise<void> =>
                canal.signalTyping!({ tenantId, conversationId: input.conversationId }),
            }
          : {}),
      });
      runLog.info('atraso humano antes da 1ª bolha', { atraso_ms: ms, fora_do_lock: true });
    },
    // `finalBody` = corpo após a cadeia (o disclosureGate F4-05 pode prependar o
    // disclosure via inject); é ELE que vai ao canal, não o `body` capturado da tool.
    send: (finalBody: string) => {
      pararDigitando(); // a mensagem sai agora; renovar depois dela mentiria
      estado.corposEnviados.push(finalBody);
      const sleep =
        deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const jitter = () =>
        // Piso no throttle anti-ban do número (1.2s default) — bolhas são
        // mensagens físicas. Lê os knobs da CONEXÃO (throttle_ms + jitter_max_ms,
        // 0499) e não o literal: desde a 0010 os dois já são configuração por
        // número, e o call site estava cravando `1200 + rand*800` ignorando-a.
        (pacingDoTurno?.knobs.throttleMs ?? 1200) +
        Math.floor(Math.random() * (pacingDoTurno?.knobs.jitterMaxMs ?? 800));
      const enviar = (
        corpo: string,
        media?: FotoParaEnvio,
      ): Promise<ChannelSendResult> => {
        estado.seq += 1;
        return liveChannel().send({
          tenantId,
          leadId,
          jobId: liveJob().id,
          jobClaim: claimOfJob(liveJob()),
          agentOperation,
          seq: estado.seq,
          conversationId: input.conversationId,
          body: corpo,
          ...(media ? { media } : {}),
        });
      };
      // Cada foto é uma mensagem física: só vão as que cabem no que resta do teto
      // do turno (a checagem de `max_sends_per_turn` acima roda uma vez, antes).
      // O resto é medido ANTES DE CADA FOTO, depois do texto: o texto acima do
      // teto de legenda sai à parte e também gasta o teto.
      return enviarComFotos(finalBody, fotosDoProduto, {
        sleep,
        jitter,
        restantes: () => maxSendsPerTurn - estado.seq,
        enviarFoto: (foto, legenda) => enviar(legenda, foto),
        enviarTexto: (texto) =>
          sendInBubbles(texto, {
            enabled: agentConfig?.splitMessages ?? false,
            maxChars: agentConfig?.splitMaxChars ?? 600,
            // O teto do turno vale para as bolhas: o que passa dele vai junto na última.
            maxBubbles: Math.max(1, maxSendsPerTurn - estado.seq),
            sleep,
            jitter,
            // A pausa humana do turno NÃO mora mais aqui: ela subiu para
            // `esperaForaDoLock` (paga antes de o guardrail tomar o lock do número) —
            // issue #654. Neste ponto fica só o jitter anti-ban entre bolhas.
            send: (bubble) => enviar(bubble),
          }),
      });
    },
  };
}
