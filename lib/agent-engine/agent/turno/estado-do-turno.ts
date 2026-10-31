/**
 * F7 do turno da IA: o estado mutável do turno (ADR-0006, D4, fatia S6).
 *
 * Variáveis MOVIDAS de `executarTurnoDoAgente` (inbound-turn.ts), onde eram `let` soltos
 * no escopo da função, com os mesmos valores iniciais e os comentários de origem. As
 * ferramentas do modelo escrevem aqui e as fases de depois do modelo leem daqui.
 * `criarEstadoDoTurno` é chamado UMA vez, no orquestrador, e o objeto passa por
 * referência: um módulo que criasse o seu zeraria a trava de duplicata e o `seq`, e o
 * lead receberia duas vezes (cerca: tests/unit/estado-do-turno-nasce-uma-vez.test.ts).
 */
import type { ChannelSendResult } from '../../channel-adapter';
import type { LeadStage } from '../lead-state';
import type { citationsFromHits } from '../search-knowledge';
import { criarTravaDeDuplicata } from '../near-dup';

export interface EstadoDoTurno {
  // Estado do RUN — vive só neste closure (isolamento por construção, acc 3).
  seq: number;
  // O que o modelo de fato mandou neste turno (depois da cadeia). A trava "a
  // pergunta saiu?" do roteiro de atendimento lê daqui.
  corposEnviados: string[];
  // DUPLICATA PRÓXIMA NO MESMO TURNO: a trava `near-dup.ts` guarda DUAS memórias.
  // `aceitos` = corpos de `send_message` que PASSARAM pela cadeia e foram aceitos
  // neste turno (o corpo PRÉ-cadeia, para comparar candidato contra candidato) —
  // a memória que a régua consulta para suprimir repetição (o defeito medido
  // em produção: 4 respostas a 1 pergunta, 3 vindas da correção do turno mudo).
  // Só conteúdos ACEITOS entram: um veto não é resposta. `emVoo` = candidatas cuja
  // cadeia ainda roda: fecha a corrida de tool calls paralelas do MESMO passo (o
  // SDK as executa juntas) — sem a reserva, todas passariam pela checagem antes de
  // qualquer envio registrar (#2996, item 6).
  dupTrava: ReturnType<typeof criarTravaDeDuplicata>;
  // #1943: o turno foi DESCARTADO como obsoleto (guard `resposta_obsoleta`, #1940)
  // ainda no run — o cliente escreveu de novo enquanto o modelo pensava. Quando
  // ligada, NADA mais sai dele, nem a pergunta pendente do roteiro (que segue
  // feita para o turno da mensagem nova). Ver `perguntaDoRoteiroPodeSair`.
  turnoDescartado: boolean;
  // TURNO MUDO: quantas vezes o modelo chamou `send_message` e se passou a conversa à
  // equipe. Os dois dizem que o silêncio foi decisão — só sem eles o motor pede a
  // correção do turno que terminou sem falar com o cliente (ver depois da chamada principal).
  tentativasDeEnvio: number;
  passouParaAEquipe: boolean;
  // F3-11: estágio que o MODELO confirmou via update_lead_state neste turno (a máquina
  // F2-10 é a única porta). Comparado com a sugestão do classificador no fim → divergência.
  confirmedStage: LeadStage | null;
  outOfTablePromiseAttempted: boolean;
  // Spec 15 (Wave 4 lê este flag): true quando open_human_case abriu um caso NESTE
  // turno — aqui só declara e seta; o consumo (ex.: guardrail de promessa) é da Wave 4.
  openedCaseThisTurn: boolean;
  vetos: {
    // Wave 4 — contador do fail-safe do guardrail anti-alucinação (case_promise_without_case):
    // 1º veto no turno é erro-de-ensino (o modelo re-tenta); persistir uma 2ª vez aciona o
    // auto-abre-caso (ver send_message.execute). Por turno (closure), nunca cross-turno.
    casePromise: number;
    // Contador do fail-safe do gate de vazamento de vocabulário interno
    // (`internal_vocabulary_leak`): 1º veto no turno ensina o modelo a reescrever; persistir
    // solta o envio com registro. Por turno (closure), nunca cross-turno.
    internalVocabulary: number;
    // Contador do fail-safe do gate de afirmação clínica (`clinical_claim`): 1º veto ensina;
    // persistir abre caso para a equipe — e o envio continua barrado. Por turno (closure).
    clinicalClaim: number;
    // Uma recusa deste tipo devolve o texto confirmado ao modelo para que ele
    // reescreva antes de falar com o cliente. Não gasta envio nem toca no canal.
    falseEmptyInbound: number;
  };
  // A pausa humana (atraso-humano.ts) já foi paga NESTE turno? Por turno
  // (closure), como os contadores acima. O turno pode passar pela cadeia
  // `before_send` mais de uma vez — o modelo pode chamar `send_message` várias
  // vezes, e os fail-safes de promessa/vocabulário re-rodam a cadeia inteira.
  // Sem este flag, cada passagem cobraria do cliente uma espera nova, e um
  // turno com dois vetos ficaria mudo por mais de 20 segundos: o conserto do
  // "rápido demais" viraria o defeito simétrico, mais caro que o original.
  jaEsperouComoHumano: boolean;
  // Cap de envio (warm-up/diário) vetado neste turno — capturado aqui porque o veto
  // não empurra outcome nenhum a `outcomes` (ver comentário no ponto de captura, mais
  // abaixo). Diferente da janela horária (checada ANTES do modelo rodar, linha ~1233):
  // o cap depende de quanto já saiu HOJE, que muda com o turno concorrente — só dá pra
  // saber com certeza no momento do envio, não antes.
  pacingCapVeto: { code: string; nextAllowedAt: Date } | null;
  // Arma o `agendaStallGate` (before-send.ts): true assim que crm_find_free_slots,
  // crm_book_appointment ou crm_reschedule_appointment executar neste turno — marcado no
  // wrapper das tools MCP, mais abaixo. `send_message` lê o valor NO MOMENTO do envio; como
  // as tools do modelo rodam em passos anteriores do mesmo loop, o valor já está certo
  // quando o modelo decide mandar a resposta.
  agendaToolCalledThisTurn: boolean;
  // Lido pelo `casePromiseGate` (#1873): true só depois de `schedule_followup` AGENDAR com
  // sucesso neste turno. Libera apenas a promessa de retorno do próprio assistente.
  followupAgendadoNesteTurno: boolean;
  outcomes: ChannelSendResult[];
  // Citações acumuladas por buscas de conhecimento DESTE turno — anexadas à
  // próxima outbound enviada (shape de lib/ai/citations/types, que a UI já lê).
  pendingCitations: ReturnType<typeof citationsFromHits>;
  runError: Error | null;
}

export function criarEstadoDoTurno(): EstadoDoTurno {
  return {
    seq: 0,
    corposEnviados: [],
    dupTrava: criarTravaDeDuplicata(),
    turnoDescartado: false,
    tentativasDeEnvio: 0,
    passouParaAEquipe: false,
    confirmedStage: null,
    outOfTablePromiseAttempted: false,
    openedCaseThisTurn: false,
    vetos: { casePromise: 0, internalVocabulary: 0, clinicalClaim: 0, falseEmptyInbound: 0 },
    jaEsperouComoHumano: false,
    pacingCapVeto: null,
    agendaToolCalledThisTurn: false,
    followupAgendadoNesteTurno: false,
    outcomes: [],
    pendingCitations: [],
    runError: null,
  };
}
