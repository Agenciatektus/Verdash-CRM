import { TIPOS_DE_CASO, TIPOS_DE_CASO_PARA_A_IA } from "@/lib/ai/case-copy";
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import { applyPreviewPolicy, previewGateContext, type TurnPreview } from './preview';
import { claimOfJob } from '../queue/claim';
import { currentExecutionBoundary, guardServiceEffect } from '@/lib/atendimento/fronteira-server';
/**
 * Loop do agente v0 — handler do job `inbound_turn` (F2-09; blueprint 8.8).
 *
 * Cada job vira uma sessão FRESCA do motor LLM (via seam F2-23 — provider
 * instanciado POR CHAMADA, nunca cache por lead em memória de processo): TODO o
 * estado do run (seq de envio, outcomes, mensagens) vive no closure desta
 * invocação — isolamento entre leads por construção (acceptance 3).
 *
 * Ritual imposto pelo RUNTIME, não pelo modelo:
 *   1. abre lendo playbook (system, por ponteiro — F2-07) + checkpoint anterior de
 *      `lead_checkpoints` (compromissos/objeções/next_action + rolling summary) +
 *      `lead_state` (estágio do funil — F2-10) + últimas N mensagens via
 *      get_lead_context (F2-08);
 *   2. o modelo decide tools livremente: `get_lead_context` (releitura),
 *      `send_message` — enviar é SEMPRE tool call (CLAUDE.md princípio 2); texto
 *      direto do modelo NUNCA vira mensagem (é descartado) — e `update_lead_state`
 *      (F2-10): o modelo MARCA avanços; a máquina de estados no código valida e o
 *      avanço é espelhado no CRM (crm_move_lead_stage); falha do espelho NÃO
 *      reverte o harness (fonte da verdade) — vira log + inbox_items;
 *   3. fecha com uma 2ª chamada de modelo (purpose 'checkpoint') que devolve
 *      SOMENTE o JSON do checkpoint, validado por Zod e persistido — mecanismo
 *      escolhido por ser imposto pelo runtime (tool update_checkpoint dependeria
 *      de o modelo lembrar de chamá-la; a chamada de fechamento sempre acontece).
 *
 * Falhas: transporte/tool do CRM viram mensagem de ensino pro modelo no meio do
 * run (padrão F2-08) E erro do job no fim (retry da fila com o ledger segurando
 * duplicata); veto is_blocked cancela o job em definitivo (JobSettledError —
 * main.ts não completa nem re-tenta). PII nunca entra em log/erro de job.
 */
import type pg from 'pg';
import { z } from 'zod';
import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';

import { withFields, type Logger } from '../obs/logger';
import {
  corpoDaMensagem,
  getLeadContext,
  textoDoClienteNaUltimaMensagem,
  type CorpoDaMensagemRow,
  type LeadContext,
  type LeadContextMessage,
} from '../edge/crm/get-lead-context';
import type { CrmEdgeConfig } from '../edge/crm/mcp-client';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import {
  LlmBudgetExceededError,
  runModelCall,
  tool,
  type LlmEdgeConfig,
  type ModelMessage,
  type ToolSet,
} from '../edge/llm/run-model-call';
import type { ProviderRegistry } from '../edge/llm/providers';
import { HANDOFF_REASON_ORCAMENTO } from '../edge/llm/orcamento';
import { criarConferidorDeAfirmacoes } from '@/lib/ai/decisao/afirmacao-de-fato';
import { createAdminClient } from '@/lib/supabase/admin';
import { moverLeadParaEtapaDeHandoff } from '@/lib/leads/handoff-stage-move';
import { buildNativeMediaParts } from './media-parts';
import {
  copiarFotoNoStorage,
  enviarComFotos,
  prepararFotosDoProduto,
  PASTA_DE_TESTE_DE_MIDIA,
  type FotoParaEnvio,
} from './fotos-do-produto';
import { rescheduleJob, type JobRow, type Queryable } from '../queue/queue';
import {
  type LeadStage,
  type LeadStateRow,
} from './lead-state';

// ── Recorte 1 do #636 ────────────────────────────────────────────────────────
// O checkpoint e a abertura do turno moram em `./abertura/` desde este PR e
// voltam AQUI em reexport (bloco "Recorte 1 do #636", mais abaixo): o caminho
// legado `inbound-turn` é o que os testes e os irmãos buscam, e o grep deles
// não pode quebrar com a extração.
import {
  CHECKPOINT_INSTRUCTION,
  checkpointContentSchema,
  fecharOTurno,
  insertCheckpoint,
  parseCheckpointText,
  type CheckpointContent,
  type LeadCheckpointRow,
} from "./abertura/checkpoint";
import { buildOpeningMessage, ritualBlocks } from "./abertura/ritual";
import { agendaNoFechamento } from './abertura/agenda-no-fechamento';
import { type FollowupWindowKnobs } from './schedule-followup';
import { podeExporScheduleFollowup } from '@/lib/followup/callback-policy';
import {
  avisarLeadDaEscalacao,
  avisarLeadLendoOContato,
  type AvisoDeEscalacaoIds,
  type AvisoDeEscalacaoOpts,
  type DesfechoDoAviso,
} from './aviso-de-escalacao';
import {
  detectAmbiguousOptOut,
  detectHumanHandoffRequest,
  isLeadInHandoff,
  performHumanHandoff,
} from './human-handoff';
import {
  type CompactionKnobs,
} from './compaction';
import { pruneToolResults, toolPartsAsText, type PruneToolResultsKnobs } from './prune-tool-results';
import {
  classifyStage,
  renderStageHint,
  type StageClassifierKnobs,
} from './stage-classifier';
import { classificadoresDoTurno } from './classificadores-do-turno';
import {
  turnoProjeta,
} from './projecao';
import {
  capacidadesEntreguesAoOperador,
  catalogoEntregueAoOperador,
} from './entrega-de-capacidade';
import { loadPublishedAgentConfigById, matchesHandoffKeyword, type PublishedAgentConfig } from './agent-config';
import { garantirPerguntaDoRoteiro, perguntaDoRoteiroPodeSair } from './roteiro-no-turno';
import { loadChannelKnobs } from '../pacing/store';
import { resolveConversationTurn, type TurnAgentResolution } from './resolve-turn-agent';
import {
  hasOpenCaseForContact,
  getCaseAwaitingLead,
  openCase,
} from './human-cases';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { definicaoNaConexao } from '@/lib/channels/linha-do-espelho';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import {
  latestInboundSignal,
  recentInboundSignal,
  matchSkills,
  recordSkillMissCandidates,
  renderMatchedSkillBodies,
} from './skills';
import { skillHasReferences } from './skill-references';
import { READ_ONLY_TOOLS, wrapToolsWithBreaker, type ToolBreakerThresholds } from './tool-breaker';
import {
  loadChannelProvider,
  nomesDasFerramentas,
  runBeforeSend,
  tipoDeEnvio,
} from '../guardrails/before-send';
import { isStatusSendable } from '../../channels/meta/template-binding';
import { capabilitiesOf } from '@/lib/channels/capabilities';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { esperarComoHumano, manterDigitando } from './atraso-humano';
import { instrucaoDeBolhas, sendInBubbles, splitForSend } from './split-message';
import { formatarParaWhatsApp } from './formato-whatsapp';
import type { DisclosureMode } from '../guardrails/disclosure/template';
import { decidePromise } from '../guardrails/promise/engine';
import { loadPromiseTable } from '../guardrails/promise/table';
import {
  carregarFontesQueProvamOferta,
  criarEvidenciasComerciaisDoTurno,
} from '../guardrails/promise/evidencias-comerciais';
import { criarRecuperadorDeEvidencias } from '../guardrails/promise/recuperar-evidencias';
import { classifyPromise, memoizarPorCandidata } from '../guardrails/promise/semantic';
import { montarContextoDaRevisao } from '../guardrails/promise/contexto-da-revisao';
import {
  montarBriefingDaPassagem,
  type BriefingDaPassagem,
} from '@/lib/escalacao/briefing-da-passagem';
import { CORRECAO_DO_TURNO_MUDO, turnoMudoPedeCorrecao } from './turno-mudo';
import { vetoReason } from '@/lib/leads/veto-activity';
import { corposEnviadosDesdeUltimaInbound } from './memoria-envio';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import {
  JAILBREAK_ESCALATION_LEVEL,
  classifyJailbreak,
  escalateJailbreakPromise,
  type JailbreakClassifierKnobs,
  type JailbreakLevel,
} from '../guardrails/jailbreak/classifier';
import { camadaLigada } from '../guardrails/camadas-da-org';
import { avaliarPortoesDeEntrada } from './turno/portoes-de-entrada';
import { criarEstadoDoTurno } from './turno/estado-do-turno';
import { criarGetLeadContext, criarGetLeadNote, criarReadSkillReference, criarSearchKnowledge } from './turno/ferramentas/leitura';
import { criarSaveLeadNote, criarScheduleFollowup, criarUpdateLeadState } from './turno/ferramentas/lead';
import { criarOpenHumanCase, criarProvideCaseUpdate, criarRequestHumanHandoff } from './turno/ferramentas/equipe';
import { carregarContextoDoTurno } from './turno/contexto';
import { executarEfeitosPosTurno } from './turno/efeitos-pos-turno';
import { resolverRoteamentoDoTurno } from './turno/roteamento';
import { tratarDesviosDeterministicos } from './turno/desvios-deterministicos';
import { prepararContextoDoTurno } from './turno/preparo-do-contexto';
import {
  nivelFinalDaManipulacao,
  perguntarManipulacaoAoJev,
  registrarManipulacaoDoJev,
  type ManipulacaoDoJev,
} from '@/lib/ai/decisao/manipulacao';
import type { DependenciasDoPonto } from '@/lib/ai/decisao/ponto';
import { fusoDaOrganizacao } from './fuso-da-org';
import { renderAgora } from '@/lib/tempo/agora';
import { decidirElegibilidadeDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';
import { MAX_TURNOS_POR_CONDUCAO } from '@/lib/cadencia/conducao/settings';
import { filtrarRawTools } from '@/lib/cadencia/conducao/presets';
import { restringirAConducao } from '@/lib/cadencia/conducao/ferramentas';
import {
  avisarEquipeDoRascunho,
  blocoDaConducao,
  conducaoVivaDaConversa,
  contarTurno,
  encerrarConducaoEPassarParaHumano,
  nomeDaEtapa,
  restringirConfigAConducao,
  type ConducaoViva,
} from '@/lib/cadencia/conducao/turno';
import {
  anotarUltimaInboundVista,
  respostaFicouObsoleta,
  ultimaInboundJaRespondida,
} from './turno-ja-respondido';

/**
 * A descrição da ferramenta `request_human_handoff` nos DOIS lados da chave por
 * assunto jurídico (#2097, #2156).
 *
 * A chave NÃO remove a ferramenta nem cria caminho novo: ela troca só o trecho
 * que manda o modelo passar a conversa em "questão jurídica/financeira
 * sensível". Com a chave desligada, sai SÓ o jurídico: a ferramenta existe com
 * uma frase dizendo que assunto jurídico é o trabalho normal deste atendimento e
 * não é, sozinho, motivo para passar a conversa — o modelo continua livre para
 * passar por reclamação séria, questão financeira sensível, pedido da pessoa ou
 * limite do que pode resolver.
 *
 * O que a chave NÃO toca, por decisão do mantenedor (condições 4 do desenho):
 * `detectHumanHandoffRequest` (o pedido explícito de "quero falar com alguém")
 * e `handoff_keywords` (a escolha de quem configura o agente) continuam sempre
 * ligados.
 *
 * `true` devolve, BYTE A BYTE, a descrição de antes — é a garantia de que quem
 * não mexer em nada não muda nada. O texto de um lado só existe uma vez: quem
 * editar o rodapé altera os dois.
 */
export function descricaoDaFerramentaDePassagem(handoffLegalEnabled: boolean): string {
  return (
    'Passa a conversa para um ATENDENTE HUMANO imediatamente. Use quando o lead pedir para falar com ' +
    'uma pessoa, quando a situação exigir alguém humano ' +
    (handoffLegalEnabled
      ? '(reclamação séria, questão jurídica/financeira sensível) '
      : '(reclamação séria, questão financeira sensível; assunto jurídico é o trabalho normal ' +
        'deste atendimento e não é, sozinho, motivo para passar a conversa) ') +
    'ou quando você atingir o limite do que pode resolver. ' +
    'AVISE O LEAD ANTES: mande uma mensagem dizendo que você vai chamar alguém da equipe e SÓ ENTÃO ' +
    'chame esta ferramenta — depois dela você não consegue mais falar com ele. Se você não avisar, ' +
    'o sistema manda um aviso padrão no seu lugar. Acionada a ferramenta, encerre o turno. ' +
    'NUNCA diga ao lead que "já chamei alguém" ou "já passei para a equipe" sem ter chamado esta ' +
    'ferramenta NO MESMO turno — a frase no passado não substitui a ação, e ninguém é avisado de ' +
    'verdade. Preencha por_que, o_que_tentei e cliente_quer — quem assumir só vê o que você escrever ' +
    'aqui.'
  );
}

/**
 * A TROCA da descrição, num ponto só, exercitável fora do turno.
 *
 * Chamada por `executarTurnoDoAgente` logo abaixo do ponto que REMOVE a
 * ferramenta quando `handoff_tool_enabled` está desligado. Se a ferramenta não
 * está mais no conjunto (chave irmã desligada), aqui não há o que trocar e a
 * função devolve sem tocar em nada — a ausência é da irmã, não dela.
 *
 * `undefined` (fixture antiga que ainda não lê a coluna) conta como LIGADO:
 * é o lado seguro e é o padrão da coluna.
 */
export function aplicaAChaveDeAssuntoJuridico(
  rawTools: Record<string, unknown>,
  handoffLegalEnabled: boolean | undefined,
): void {
  if (handoffLegalEnabled !== false) return;
  const ferramenta = rawTools.request_human_handoff;
  if (typeof ferramenta === 'object' && ferramenta !== null) {
    rawTools.request_human_handoff = {
      ...ferramenta,
      description: descricaoDaFerramentaDePassagem(false),
    };
  }
}

/**
 * Superfície ESTÁTICA das tools do agente (description + inputSchema) — parte do
 * prefixo estável de cache (F2-17). Única fonte: o handler monta as tools reais
 * daqui (+ execute do closure) e `scripts/ops-count-prefix.ts` mede o prefixo
 * real sem precisar de um run. Nada volátil entra aqui, por construção.
 *
 * A descrição de `request_human_handoff` sai de
 * `descricaoDaFerramentaDePassagem(true)` — valor de módulo, constante como o
 * literal que estava aqui, e com UMA fonte só: a versão desligada da frase mora
 * na mesma função, então os dois lados não podem divergir.
 */
export const AGENT_TOOL_DEFS = {
  get_lead_context: {
    description:
      'Relê o contexto curado do lead nesta organização: dados do contato e as últimas mensagens da conversa.',
    inputSchema: z.object({}),
  },
  send_message: {
    description:
      'Envia UMA mensagem de WhatsApp ao lead desta conversa. É o ÚNICO jeito de falar com o lead; texto fora desta tool nunca é enviado.',
    inputSchema: z.object({
      body: z.string().min(1).describe('corpo da mensagem, em pt-br, pronto para envio'),
      produto_codigo: z
        .string()
        .optional()
        .describe(
          'código de um produto do catálogo (o `codigo` de crm_search_products) que tem `fotos`: ' +
            'as fotos dele vão junto, e o texto vira a legenda da primeira',
        ),
    }),
  },
  update_lead_state: {
    description:
      'Marca um avanço REAL no funil deste lead: stage (new → contacted → qualifying → qualified → ' +
      'negotiating → won | lost; só o PRÓXIMO estágio válido — regressão é rejeitada), qualification ' +
      '(budget/authority/need/timeline), next_action e reason (evidência curta do avanço). ' +
      'Nunca invente avanço sem evidência na conversa.',
    // Schema LARGO só para o SDK (o modelo vê os campos); a validação REAL é a
    // whitelist .strict() dentro de applyLeadStateUpdate — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        stage: z.string().optional().describe('novo estágio do funil (só o próximo válido)'),
        qualification: z
          .object({})
          .passthrough()
          .optional()
          .describe('qualificação: budget, authority, need, timeline'),
        next_action: z
          .string()
          .nullable()
          .optional()
          .describe('próxima ação concreta combinada com o lead'),
        reason: z.string().optional().describe('evidência curta do avanço (vai ao audit do CRM)'),
      })
      .passthrough(),
  },
  schedule_followup: {
    description:
      'Agenda o SEU próprio retorno a este lead num momento futuro (follow-up). Use sempre que ' +
      'prometer voltar a falar depois (ex.: "te retorno amanhã de manhã", "confirmo na segunda"). ' +
      'Um agendamento por promessa; o sistema fará o follow-up sozinho no horário combinado — ' +
      'depois de agendar, encerre o turno.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applyScheduleFollowup — campo
    // extra/forjado e data inválida viram erro de ENSINO ao modelo, nunca exceção do SDK.
    inputSchema: z
      .object({
        reason: z.string().describe('por que agendar o retorno'),
        promised_at: z
          .string()
          .describe('data/hora ISO 8601 do retorno (no futuro), ex.: "2026-07-15T14:00:00Z"'),
        promise: z.string().describe('o que você prometeu ao lead'),
        context_snapshot: z
          .string()
          .nullable()
          .optional()
          .describe('contexto curto para o seu run futuro'),
      })
      .passthrough(),
  },
  save_lead_note: {
    description:
      'Salva uma nota DURÁVEL na memória deste lead (persiste entre conversas). Use para fatos que ' +
      'você vai querer lembrar depois: preferências, contexto pessoal, restrições, o que já foi ' +
      'oferecido. A headline (linha curta) entra sempre no índice de memória do lead; o corpo completo ' +
      'fica guardado e você o relê sob demanda com get_lead_note. Para CONSOLIDAR notas antigas, ' +
      'liste os ids delas em "supersedes" (você os vê no índice) — elas são removidas ao salvar a nova.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applySaveLeadNote — campo
    // extra/forjado vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        headline: z.string().describe('linha curta do índice (sempre visível no prompt)'),
        body: z.string().describe('corpo completo da nota (lido sob demanda por get_lead_note)'),
        supersedes: z
          .array(z.string())
          .optional()
          .describe('ids de notas que esta substitui/consolida (vistos no índice de memória)'),
      })
      .passthrough(),
  },
  get_lead_note: {
    description:
      'Lê o CORPO completo de UMA nota da memória deste lead pelo id (o id aparece no índice de memória, ' +
      'entre colchetes). Use quando a headline no índice não bastar e você precisar do detalhe.',
    inputSchema: z
      .object({
        note_id: z.string().describe('id da nota (como aparece no índice, entre colchetes)'),
      })
      .passthrough(),
  },
  search_knowledge: {
    description:
      'Busca na BASE DE CONHECIMENTO da organização (FAQ, políticas, catálogo) os trechos mais ' +
      'relevantes para uma pergunta. Use ANTES de responder qualquer dúvida factual sobre produto, ' +
      'preço, prazo, política ou funcionamento — responda com base nos trechos retornados e não ' +
      'invente o que não encontrar. Sem resultados = diga que vai confirmar, nunca chute.',
    inputSchema: z
      .object({
        query: z.string().min(2).describe('a pergunta ou termos a buscar, em pt-br'),
      })
      .passthrough(),
  },
  request_human_handoff: {
    // Lado LIGADO da chave por assunto jurídico (#2156): o texto inteiro mora
    // em `descricaoDaFerramentaDePassagem`, que também escreve o lado
    // desligado — e é ela quem o handler usa quando a versão desliga a chave.
    description: descricaoDaFerramentaDePassagem(true),
    // Schema LARGO para o SDK (o modelo vê o campo); a validação REAL é a whitelist .strict()
    // + guard de prototype pollution dentro de applyRequestHumanHandoff — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    //
    // ⚠️ ESPELHO: as chaves aqui e as de `requestHumanHandoffInputSchema`
    // (`human-handoff.ts`) são o MESMO conjunto, e
    // `tests/unit/passagem-tool-schema-espelhado.test.ts` as compara. Campo só
    // deste lado = o modelo preenche e a whitelist recusa, virando erro de
    // ensino a cada chamada; campo só do outro = o modelo nunca sabe que existe.
    //
    // Os `.describe()` são o ÚNICO lugar onde o modelo aprende o que escrever, e
    // é por isso que eles trazem exemplo em vez de definição.
    inputSchema: z
      .object({
        por_que: z
          .string()
          .optional()
          .describe(
            'em uma frase, por que você não consegue resolver e está passando para uma pessoa',
          ),
        o_que_tentei: z
          .array(
            z.object({
              o_que: z
                .string()
                .describe('o que você tentou (ex.: "busquei na base a política de desconto")'),
              desfecho: z.string().optional().describe('no que deu (ex.: "a política só vai até 10%")'),
            }),
          )
          .optional()
          .describe('o que você já tentou, na ordem — evita que a pessoa refaça o mesmo caminho'),
        cliente_quer: z
          .string()
          .optional()
          .describe('o que a pessoa está pedindo, nas palavras dela'),
        reason: z.string().optional().describe('sinônimo antigo de por_que (ainda aceito)'),
      })
      .passthrough(),
  },
  read_skill_reference: {
    description:
      'Lê o conteúdo de UMA reference (arquivo de apoio) do pacote de uma skill situacional que já ' +
      'CASOU neste turno. Use quando o corpo da skill ativa mencionar uma reference e você precisar do ' +
      'detalhe completo dela. Só funciona para skills ativas AGORA — pedir skill não ativa ou caminho ' +
      'fora do manifesto dela volta erro.',
    inputSchema: z
      .object({
        skill_name: z
          .string()
          .min(1)
          .describe('nome da skill ativa neste turno (como aparece no bloco de skills)'),
        ref_path: z.string().min(1).describe('caminho da reference dentro do pacote da skill'),
      })
      .passthrough(),
  },
  open_human_case: {
    description:
      'Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead ' +
      'sozinho (liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA ' +
      'conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai ' +
      'verificar/resolver: prometer sem abrir o caso é proibido. Isso vale mesmo quando você nomeia a ' +
      'pessoa ("vou confirmar com o Fulano", "já registrei com a equipe") — nomear alguém não abre o caso; ' +
      'só esta ferramenta abre. Chame-a NO MESMO turno em que fizer a promessa, nunca depois.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() openHumanCaseInputSchema (human-cases.ts) — campo extra/forjado vira
    // erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        title: z.string().describe('título curto, ex.: "Liberar acesso ao painel"'),
        summary: z.string().describe('o que o lead precisa, em pt-br'),
        blocker: z.string().describe('por que você não consegue resolver sozinho'),
        // O assunto serve para quem TRIA a fila separar antes de ler. O detalhe
        // continua no título e no resumo — este campo não os substitui, e por
        // isso a lista é curta: muitas opções produzem classificação
        // inconsistente, e aí o filtro atrapalha em vez de ajudar.
        kind: z
          .enum(Object.keys(TIPOS_DE_CASO) as [string, ...string[]])
          .describe(
            'do que o caso trata, para a equipe triar: ' +
              Object.entries(TIPOS_DE_CASO_PARA_A_IA)
                .map(([k, o]) => `${k} (${o})`)
                .join('; ') +
              '. Na dúvida entre dois, escolha o que descreve o PEDIDO, não o obstáculo.',
          ),
      })
      .passthrough(),
  },
  provide_case_update: {
    description:
      'Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, ' +
      'use esta tool para devolver a informação ao humano responsável. Não invente — só o que o lead disse.',
    // Schema LARGO para o SDK; a validação REAL é a whitelist .strict()
    // provideCaseUpdateInputSchema (human-cases.ts).
    inputSchema: z
      .object({
        case_id: z.string().describe('id do caso aberto'),
        info: z.string().describe('a informação colhida do lead'),
      })
      .passthrough(),
  },
  send_template: {
    description:
      'Envia um TEMPLATE aprovado do WhatsApp. Use SOMENTE quando o send_message for recusado ' +
      'porque a janela de 24 horas com o contato fechou — a mensagem de erro diz quando é o caso. ' +
      'Você precisa do nome exato do template, do idioma e de um valor para CADA parâmetro. ' +
      'Se faltar valor, a resposta diz quais e você pode chamar de novo; qualquer outro erro ' +
      'significa que um humano precisa agir — encerre o turno sem insistir.',
    inputSchema: z
      .object({
        template_name: z.string().min(1).describe('nome exato do template, como aprovado na Meta'),
        language: z.string().min(2).describe('código do idioma, ex.: pt_BR'),
        values: z
          .record(z.string(), z.string())
          .describe(
            'valor de cada parâmetro, na chave que a tela de templates mostra (ex.: "1", "2")',
          ),
      })
      .passthrough(),
  },
} as const;

/**
 * Quantos vetos de `internal_vocabulary_leak` o turno tolera antes de o fail-safe soltar
 * o envio (ver o bloco em `send_message.execute`). Mesmo degrau do fail-safe de casos
 * humanos — 1ª vez ensina, a 2ª decide — porque a assimetria é a mesma: uma reescrita
 * que o modelo não fez não vale um cliente sem resposta.
 */
export const MAX_VETOS_DE_VOCABULARIO_INTERNO = 2;

/**
 * Quantos vetos de `clinical_claim` o turno tolera antes do fail-safe. A saída aqui é
 * a OPOSTA da do vocabulário interno: aquele solta o envio, este NUNCA solta — uma
 * frase com diagnóstico ou dose não sai por insistência do modelo. O que o fail-safe
 * faz é chamar a equipe (abre um caso), e aí o modelo tem uma saída honesta: dizer que
 * a equipe vai falar com a pessoa, que agora é verdade.
 */
export const MAX_VETOS_DE_AFIRMACAO_CLINICA = 2;

/**
 * O mesmo degrau para o veto de `false_empty_inbound`, e pela mesma assimetria.
 *
 * Sem teto, o contador só subia: um falso positivo teimoso da detecção calava o
 * turno INTEIRO — o cliente ficava sem resposta por causa de uma frase nossa,
 * não de uma frase dele. Medido no regex desta entrega, num corpus de 6 frases
 * legítimas de atendimento, 1 disparava o veto. Uma barreira de conteúdo que
 * não sabe desistir troca um erro visível (a frase falsa) por um invisível (o
 * silêncio), e o invisível é pior: ninguém o percebe do lado de cá.
 *
 * Soltar NÃO é soltar calado — o fail-safe registra (`runLog.warn`), que é o
 * laço de retorno: o turno em que a barreira errou fica legível depois.
 */
export const MAX_VETOS_DE_FALSO_VAZIO = 2;

/**
 * Teto de mensagens FÍSICAS enviadas ao lead por turno quando `knobs.maxSendsPerTurn`
 * está ausente (testes) — produção sempre recebe o knob do env (MAX_SENDS_PER_TURN).
 *
 * Existe porque NENHUM gate de before-send limita CONTAGEM por turno — `pacing` só
 * limita RITMO (tempo entre envios), não quantidade. Sem este teto, um modelo que
 * decida tratar uma lista de perguntas de qualificação como uma mensagem por pergunta
 * (em vez de perguntar uma e esperar a resposta) só para no teto genérico de STEPS do
 * loop de tools (AGENT_MAX_STEPS) — e esse teto conta QUALQUER tool, não só envio.
 * Medido em produção: um lead recebeu 8 mensagens seguidas do mesmo turno.
 */
export const DEFAULT_MAX_SENDS_PER_TURN = 3;

/**
 * Job já saiu de 'running' por decisão do próprio run (ex.: cancelJob no veto
 * is_blocked) — o worker NÃO deve completar nem re-tentar. main.ts trata via
 * failJob, que no-opa (lease já não é dele) — estado final é o que o run deixou.
 */
export class JobSettledError extends Error {
  override readonly name = 'job_settled';
}

// Shape que o drain (F2-05) grava no payload do job — organization/lead vêm da
// ROW do job (fonte confiável), nunca daqui; o payload só carrega ponteiros do CRM.
const inboundTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
    crm_event_id: z.string().uuid(),
  })
  .passthrough();

/**
 * O evento já traz o id exato da mensagem que acordou o agente. Ler o "último
 * inbound" da conversa novamente abre uma corrida: outro evento do canal pode
 * entrar entre o despacho e o turno, e o agente passa a responder ao registro
 * errado. A resposta deve sempre usar esta linha canônica.
 *
 * ⚠️ Ela é COMPOSTA pelo mesmo caminho do histórico (`corpoDaMensagem`), nunca
 * pela coluna `body` crua. Áudio e foto chegam do WhatsApp sem legenda — `body`
 * NULL e o conteúdo no derivado (transcrição/visão, gravado DEPOIS pelo
 * `workers/media-derive-worker.ts`: é essa a corrida que se mede aqui) ou no
 * marcador `[tipo]`. Lida crua, a linha canônica valia `''` enquanto o histórico
 * logo abaixo mostrava o texto do cliente — e os DOIS lados do defeito saem
 * daqui: a abertura anunciava "não há texto utilizável" sobre uma mensagem que
 * tem texto, e a barreira do falso-vazio desarmava, porque
 * `claimsCurrentInboundIsEmpty` devolve `false` quando o texto canônico é `''`.
 * (issue #617)
 *
 * Exportada só para o teste: o recorte (org + conversa + id + `direction`) é o
 * que impede um id de outra conversa — ou uma outbound — de virar "a mensagem
 * atual", e um recorte não se prova lendo a chamada.
 */
export async function loadInboundBodyForJob(
  db: Queryable,
  input: { tenantId: string; conversationId: string; inboundMessageId: string },
): Promise<string | null> {
  const result = await db.query<CorpoDaMensagemRow>(
    `select type, body, media_url, media_storage_path, media_derived_text
       from messages
      where organization_id = $1
        and conversation_id = $2
        and id = $3
        and direction = 'inbound'
      limit 1`,
    [input.tenantId, input.conversationId, input.inboundMessageId],
  );
  const row = result.rows[0];
  return row === undefined ? null : corpoDaMensagem(row);
}

/**
 * Recorte 1 do #636: o checkpoint (schema, ROW, instrução do fechamento,
 * gravação e parse) e a abertura (`ritualBlocks` + `buildOpeningMessage`) moram
 * em `./abertura/` desde este PR — este arquivo orquestra.
 *
 * O reexport AQUI não é enfeite: é por `inbound-turn` que os testes e os irmãos
 * (follow-up, resposta de caso, retomada da escalação) buscam estes símbolos, e
 * o grep deles tem de continuar achando. Trocar os chamadores de lugar é
 * recorte posterior — não este.
 */
export {
  CHECKPOINT_INSTRUCTION,
  checkpointContentSchema,
  parseCheckpointText,
  ritualBlocks,
  buildOpeningMessage,
};
export type { CheckpointContent, LeadCheckpointRow };

/**
 * Reexportado do módulo puro, onde ele PRECISA morar: o caminho legado
 * (`workers/ai-response-worker.ts`) grava a mesma razão e não pode importar este
 * arquivo. Fica visível aqui porque é daqui que o engine a grava.
 */
export { HANDOFF_REASON_ORCAMENTO };

/**
 * Primeira linha do resumo que vai ao humano quando o orçamento interrompe o
 * turno. É TEXTO FIXO, e tem de ser: o desvio existe porque não há orçamento
 * para chamar o modelo, então gerar este resumo por LLM seria gastar exatamente
 * o que acabou de ser recusado. O contexto útil vem logo abaixo, do checkpoint
 * durável (`buildHandoffSummary`), que também não custa token nenhum.
 */
export const RESUMO_DO_HANDOFF_POR_ORCAMENTO =
  'A IA parou de responder porque o teto de gasto mensal com IA desta organização foi ' +
  'atingido — o lead NÃO pediu atendimento humano. Assuma a conversa; para devolvê-la ao ' +
  'atendimento automático, ajuste o teto em Uso de IA › Orçamento e use "Devolver à IA" ' +
  'no cabeçalho da conversa.';

/** Título do item da Central que este handoff abre — rótulo visível, logo constante. */
export const TITULO_DO_HANDOFF_POR_ORCAMENTO = 'Teto de gasto com IA atingido — assumir a conversa';

/**
 * ORÇAMENTO ESGOTADO NÃO PODE VIRAR SILÊNCIO PARA O LEAD.
 *
 * `aplicarOrcamento` recusa a chamada ANTES de sair byte para o provedor
 * (`../edge/llm/run-model-call.ts`), e a exceção subia direto para o `catch` do
 * worker. Do lado de fora, no WhatsApp, isso é uma pessoa que perguntou alguma
 * coisa e não recebeu resposta nenhuma — nem da IA, nem de gente. A proteção que
 * existe para salvar dinheiro quebrava o invariante 4 da doutrina do Sistema
 * Vivo: nenhuma demanda sem próximo passo.
 *
 * A resposta certa já existe no repositório e é feita exatamente para isto:
 * `performHumanHandoff` transiciona a conversa `ai_handling`→`pending` (fila
 * humana), silencia o bot, cancela os follow-ups agendados do lead e abre um
 * `agent_inbox_items` kind `handoff` — TUDO em banco, SEM GASTAR UM TOKEN, o que
 * aqui não é detalhe: o motivo do desvio é justamente não haver orçamento. Por
 * isso o resumo é texto fixo mais o checkpoint durável, nunca um resumo gerado.
 *
 * RELANÇA sempre. Quem decide o destino do job é a fila
 * (`workers/agent-worker/main.ts` manda erro terminal para `cancelJob`, não para
 * `failJob`). Engolir aqui trocaria uma falha visível por uma silenciosa, e pior:
 * o turno seguiria para o fechamento como se o modelo tivesse respondido.
 *
 * Se o PRÓPRIO handoff falhar (banco fora), a exceção DELE é que sobe — e é o
 * comportamento certo: ela não é terminal, então o job re-tenta e o handoff volta
 * a ser tentado. Preservar o erro de orçamento aqui faria o job ser cancelado com
 * o lead ainda no vácuo, que é o defeito que esta função existe para fechar.
 *
 * É função de módulo, e não closure do turno, para poder ser exercitada sozinha:
 * o caminho de erro de um turno de agente é caro demais para se provar só de
 * ponta a ponta, e o que precisa ser provado aqui é pequeno e exato.
 *
 * ═══ POR QUE ELA ENVOLVE O TURNO INTEIRO, E NÃO AS CHAMADAS DE MODELO ═══
 *
 * A primeira versão envolvia as DUAS chamadas diretas de `runModelCall` do
 * turno. Estava errada, e do jeito mais silencioso possível: o turno faz outras
 * chamadas de modelo ANTES delas, por funções auxiliares —
 * `classifyStage` (`stage-classifier.ts`, purpose `stage_classifier`, roda em
 * TODO turno porque `main.ts` monta `stageClassifier: {…}` como literal de
 * objeto, sempre definido) e `maybeCompact`/flush (`compaction.ts`, purposes
 * `compaction`/`flush`). Nenhum desses purposes está em `PURPOSES_ISENTOS`, e
 * nenhum tinha try/catch: com o teto estourado, o erro subia do classificador
 * ANTES de a escolta existir, o handoff NUNCA rodava, e o worker — que lê
 * `terminal` e chama `cancelJob` — descartava o job. Lead no vácuo, sem retry,
 * sem alerta. A escolta cobria o caso raro e faltava no dominante.
 *
 * Envolver o turno inteiro é o único desenho que não envelhece: não há lista de
 * auxiliares a manter, e o auxiliar que alguém acrescentar amanhã já nasce
 * coberto. `briefingDoCheckpoint` é uma FUNÇÃO resolvida dentro do catch (e não um
 * valor pronto), porque no caminho novo a escolta abre antes de o checkpoint ter
 * sido lido — e ler o checkpoint no caminho feliz seria uma query a mais por
 * turno para um texto que quase nunca é usado.
 */
export async function comHandoffSeOrcamentoAcabar<T>(
  ctx: {
    pool: pg.Pool;
    tenantId: string;
    leadId: string;
    conversationId: string;
    /**
     * Resolvido SÓ no caminho de erro: montado do checkpoint durável, zero LLM.
     *
     * Devolve o BRIEFING inteiro, e não só o texto, porque a linha da passagem
     * guarda as quatro colunas que ele carrega. Um campo, um significado: "o
     * contexto que vai para quem assume".
     */
    briefingDoCheckpoint: () => Promise<BriefingDaPassagem>;
    /**
     * Avisa o lead de que uma pessoa vai assumir, ANTES do handoff.
     *
     * Também resolvido só no caminho de erro, e pela mesma razão do resumo: o
     * caminho feliz não deve pagar por nada disto. O aviso é texto de CÓDIGO,
     * então não gasta um token — o que aqui não é detalhe, é o único jeito de
     * ele existir: o motivo do desvio é justamente não haver mais orçamento.
     */
    avisarLead: () => Promise<DesfechoDoAviso>;
    log: Logger;
  },
  chamada: () => Promise<T>,
): Promise<T> {
  try {
    return await chamada();
  } catch (err) {
    if (!(err instanceof LlmBudgetExceededError)) throw err;
    const doCheckpoint = await ctx.briefingDoCheckpoint();
    // AVISA antes de silenciar — ver a nota de ORDEM no gatilho determinístico:
    // `performHumanHandoff` arma a trava que o gate de envio lê, então a única
    // janela em que o aviso passa é ANTES dela.
    //
    // O try/catch NÃO é defesa contra o emissor de hoje (`avisarLeadLendoOContato`
    // já promete não lançar) — é contra a dependência que a ordem cria. Sem ele,
    // um canal fora do ar faria o cliente perder o aviso E o atendente, quando o
    // pior dos dois já teria acontecido no primeiro. Medido por
    // `tests/unit/handoff-por-orcamento.test.ts` ("aviso que falha NÃO impede a
    // passagem"), que reprovava a versão anterior desta linha.
    let aviso: DesfechoDoAviso;
    try {
      aviso = await ctx.avisarLead();
    } catch (erroDoAviso) {
      ctx.log.warn('aviso ao lead falhou antes da passagem por orçamento', {
        error:
          erroDoAviso instanceof Error ? erroDoAviso.message.slice(0, 200) : 'erro desconhecido',
      });
      aviso = { avisado: false, porque: 'erro_no_envio' };
    }
    // O texto fixo fica NA FRENTE do contexto acumulado, como antes: ele é o que
    // diz a quem assume que o cliente NÃO pediu uma pessoa — sem isso o
    // atendente responde a um pedido que não houve. Nenhum modelo é chamado
    // aqui, e é o ponto: o motivo do desvio é justamente não haver orçamento.
    const briefing: BriefingDaPassagem = {
      ...doCheckpoint,
      body: `${RESUMO_DO_HANDOFF_POR_ORCAMENTO}\n\n${doCheckpoint.body}`,
    };
    await performHumanHandoff(
      ctx.pool,
      { tenantId: ctx.tenantId, leadId: ctx.leadId, conversationId: ctx.conversationId },
      {
        reason: HANDOFF_REASON_ORCAMENTO,
        conversationSummary: briefing.body,
        inboxTitle: TITULO_DO_HANDOFF_POR_ORCAMENTO,
        passagem: { origem: 'teto_de_gasto', motivoCodigo: 'orcamento_de_ia', briefing },
        avisoAoLead: aviso,
        log: ctx.log,
      },
    );
    ctx.log.warn('turno interrompido pelo teto de gasto — conversa devolvida à fila humana', {
      lead_avisado: aviso.avisado,
    });
    throw err;
  }
}

/**
 * O resumo que vai ao humano quando o orçamento interrompe o turno, lido do
 * checkpoint durável. Falhar aqui NÃO pode impedir o handoff: sem resumo o
 * humano assume com menos contexto; sem handoff ele não assume nada.
 */
async function briefingDoCheckpointDuravel(
  pool: pg.Pool,
  tenantId: string,
  leadId: string,
  log: Logger,
): Promise<BriefingDaPassagem> {
  const montar = (checkpoint: Awaited<ReturnType<typeof latestCheckpoint>>) =>
    montarBriefingDaPassagem({ checkpoint, motivo: { codigo: 'orcamento_de_ia' } });
  try {
    return montar(await latestCheckpoint(pool, tenantId, leadId));
  } catch (err) {
    log.warn('resumo do checkpoint não pôde ser lido — o handoff segue sem ele', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return montar(null);
  }
}

/**
 * Bloco de sistema RESIDENTE das tools de caso (spec 15 §5.2) — entra no prefixo
 * cacheável junto do índice de skills quando `casesEnabled`, pra não sumir em
 * conversa longa (ao contrário do índice de skills, este bloco não some).
 */
export const CASES_SYSTEM_BLOCK =
  '## Casos para um humano de retaguarda\n' +
  'Quando você NÃO conseguir resolver o pedido do lead sozinho (liberar acesso, corrigir algo num ' +
  'sistema, uma decisão que exige uma pessoa), use a tool open_human_case — você CONTINUA conversando ' +
  'com o lead, não silencia. NUNCA prometa ao lead que um humano vai verificar/resolver sem antes chamar ' +
  'open_human_case. Quando um caso estiver esperando informação do cliente e você já a obteve na ' +
  'conversa, use provide_case_update para devolver ao responsável. Ao avisar o lead que abriu o caso, ' +
  'NUNCA narre a causa técnica ou interna (erro de sistema, falha de confirmação, nome de ferramenta, ' +
  'log ou qualquer diagnóstico) — isso é assunto técnico e não vai pro cliente. `title`/`summary`/`blocker` ' +
  'são só para o humano; a mensagem ao lead diz apenas, em linguagem simples, que você vai verificar/ajustar ' +
  'e volta com uma resposta, sem explicar o motivo interno.';

/**
 * Bloco de sistema RESIDENTE de transparência — SEMPRE presente, independente de
 * `casesEnabled` ou de `open_human_case` ter sido chamado neste turno.
 *
 * Por quê: `CASES_SYSTEM_BLOCK` só ensina a não narrar a causa técnica NO MOMENTO de
 * abrir um caso — mas o modelo narra "problema no sistema" também SEM abrir caso
 * nenhum, quando só está incerto ou algo falhou silenciosamente (medido em produção,
 * 2026-08-29: "houve um pequeno problema no sistema sobre o agendamento", mandado ao
 * cliente às 11:43, sem nenhum `agent_cases` aberto naquele turno — o veto de
 * `CASES_SYSTEM_BLOCK` nunca chegou a valer porque a tool nunca foi chamada). O
 * detector de vazamento (`vazamento-interno.ts`) não pega isso por desenho — ele caça
 * FORMA (identificador técnico), não sentença comum em português — então a única
 * cura possível aqui é instrução, não filtro.
 */
export const TRANSPARENCIA_SYSTEM_BLOCK =
  '## Nunca narre problema interno ao lead\n' +
  'Em QUALQUER mensagem — abrindo caso ou não — NUNCA diga ao lead que "houve um problema/erro no ' +
  'sistema", "falha na confirmação", "erro técnico" ou qualquer variação que admita que algo deu errado ' +
  'do lado interno. Isso vale mesmo quando você está incerto do resultado de uma ferramenta ou algo ' +
  'falhou sem você entender o motivo. O lead não precisa do diagnóstico, precisa saber o que fazer ' +
  'agora: diga que vai verificar/confirmar e volta com a resposta, peça mais um instante, ou pergunte de ' +
  'novo o que falta — nunca admita que "o sistema" ou "a confirmação" teve um problema.';

/**
 * Bloco de sistema RESIDENTE da Agenda — entra no prefixo cacheável sempre que o
 * agente tem `crm_book_appointment` no `tool_ids` publicado, INDEPENDENTE de a skill
 * situacional "agendamento" ter disparado no turno.
 *
 * Por quê: a skill "agendamento" (`lib/agent-engine/agent/skills.ts`) só injeta o
 * corpo dela quando a ÚLTIMA mensagem inbound do turno bate uma keyword. Medido
 * neste repo: o turno em que o lead ACEITA um horário oferecido ("pode ser amanhã
 * às 9 então") raramente repete uma keyword de agendar — quem carrega a keyword é o
 * turno ANTERIOR, que já passou. Sem o corpo da skill presente NAQUELE turno
 * específico, o modelo confirmava o compromisso pela conversa, sem nunca chamar
 * `crm_book_appointment` — sentença dita ao cliente, nada gravado no banco. Esta
 * regra é curta, redundante com a skill de propósito e, por só depender de
 * `agentConfig.toolIds` (não da mensagem do turno), fica sempre presente.
 *
 * ⚠️ Segundo parágrafo (2026-08-29): a mesma lacuna de keyword tem um irmão mais
 * barato de cometer. Medido em produção: o lead disse "Pode ser segunda de manha"
 * e depois só "?" — nenhuma das duas bate keyword da skill "agendamento", então o
 * corpo dela (que tem a instrução "chame crm_find_free_slots e leia a resposta")
 * nunca entrou no contexto. O primeiro parágrafo deste bloco só proíbe MENTIR
 * ("confirmado" sem checar) — não obriga a CHECAR. Sem essa obrigação, o modelo
 * tinha uma saída segura e preguiçosa: responder "vou verificar e te aviso" pra
 * sempre, sem nunca chamar a ferramenta. O segundo parágrafo fecha essa saída.
 *
 * ⚠️ Terceiro parágrafo (2026-08-29, mesmo dia): o segundo parágrafo sozinho NÃO
 * bastou — medido no mesmo teste, depois de publicado. Causa raiz achada no
 * `system_prompt` que o PRÓPRIO tenant escreveu para este agente: ele instrui a
 * "encaminhar dúvidas ou situações fora da sua autonomia ao gerente Fulano".
 * O modelo estava classificando "confirmar horário" como uma dessas situações e
 * respondendo "vou confirmar com o Fulano/a equipe" — coerente com a
 * identidade que o tenant deu a ele, só que sem nunca chamar a ferramenta. Um
 * agravante: a MESMA conversa já tinha várias respostas assim ANTES deste fix
 * existir, e o modelo lê o próprio histórico — puxando a resposta pra manter
 * consistência com o que ele mesmo já disse. O terceiro parágrafo nomeia o
 * conflito explicitamente e resolve a favor da ferramenta: checar/marcar
 * agenda com uma tool disponível NUNCA é "fora da autonomia", nem quando o
 * prompt do tenant nomeia um gerente para outras decisões — e ele AINDA vale
 * pra essas outras decisões (aprovar desconto, exceção de política etc.),
 * porque este parágrafo só fala de checar/marcar horário.
 */
function agendaSystemBlock(toolIds: readonly string[]): string {
  // ⚠️ Os nomes de ferramenta deste bloco saem TODOS da lista do PRÓPRIO agente —
  // nenhum vem escrito à mão. Desde a #831 as combinações são muitas (quem tem só a
  // conjunta, quem tem só a avulsa, quem tem as duas, com ou sem a consulta e a
  // remarcação), e um dono aparando capacidades para caber no teto de 25 produz
  // qualquer uma delas. Nomear ferramenta ausente é o modo de falha que o bloco
  // irmão (`AGENDA_CONSULTA_SYSTEM_BLOCK`) existe para evitar: o modelo tenta
  // chamá-la. Uma versão anterior nomeava "`crm_book_appointment` ou
  // `crm_find_and_book_appointment`, a que estiver na sua lista" — e isso ainda
  // ensina o nome de uma ferramenta que o agente não tem.
  const tem = (nome: string): boolean => toolIds.includes(nome);
  const marcar = nomesDasFerramentas(
    ['crm_book_appointment', 'crm_find_and_book_appointment'].filter(tem),
  );
  const remarcacao = tem('crm_reschedule_appointment')
    ? ' (ou `crm_reschedule_appointment`, para remarcação)'
    : '';

  return (
    '## Agenda — nunca confirme sem checar\n' +
    'Você só pode dizer a um lead que um horário/consulta/visita está confirmado DEPOIS de chamar ' +
    `${marcar}${remarcacao} e ver o retorno confirmando o ` +
    'sucesso. Isso vale mesmo quando o lead já aceitou um horário que você ofereceu — aceite verbal não é ' +
    'reserva. NUNCA diga "confirmado", "está marcado" ou equivalente baseado só no histórico da conversa. ' +
    // ⚠️ A ressalva é obrigatória: sem ela este parágrafo ENSINA o erro. Num tipo
    // que exige aprovação, marcar devolve `aguarda_confirmacao: true` e o
    // compromisso nasce `pending` — dizer "confirmado" ali é afirmar o que
    // ninguém aprovou, e o cliente aparece num horário que pode ser recusado.
    '⚠️ EXCEÇÃO: se o retorno trouxer `aguarda_confirmacao: true`, o horário foi apenas RESERVADO e ' +
    'ainda depende de alguém da equipe aprovar. Nesse caso NÃO diga que está confirmado: diga que ' +
    'separou o horário e que a equipe confirma. ' +
    'Se ainda não chamou a ferramenta neste turno, chame antes de responder; se a chamada falhar ou você não ' +
    'tiver certeza do resultado, diga que vai verificar e NÃO afirme que está confirmado.\n' +
    // Sem a ferramenta que só CONSULTA, este parágrafo não tem o que mandar
    // chamar: mandar chamar uma que MARCA seria mandar reservar um horário que o
    // lead só mencionou. Quem tem a conjunta recebe o parágrafo dela, abaixo, e o
    // gate de agenda continua armado para os dois.
    (tem('crm_find_free_slots')
      ? 'Isso NÃO é desculpa para procrastinar: se o lead mencionou (agora ou em qualquer mensagem anterior da ' +
        'conversa) um dia/horário específico que ainda não foi checado, chame `crm_find_free_slots` ' +
        'NESTE turno antes de responder — não repita "vou verificar/confirmar e te aviso" sem ter chamado a ' +
        'ferramenta. Um "vou verificar" só é aceitável na MESMA resposta em que você já chamou a ferramenta e ' +
        'ela falhou ou não trouxe resultado; nunca como substituto de chamar.\n'
      : '') +
    // Preservar o `inicio` é o contrato de `crm_book_appointment` (`starts_at`). A
    // conjunta recebe dia e hora, não o instante — o parágrafo não se aplica a ela.
    (tem('crm_find_free_slots') && tem('crm_book_appointment')
      ? 'Se o lead escolheu um horário que VOCÊ já ofereceu nesta conversa com `crm_find_free_slots`, ele já ' +
        'foi checado: preserve o `inicio` que a ferramenta devolveu e chame `crm_book_appointment` ' +
        'diretamente. ' +
        'NÃO consulte de novo montando datas/horas em UTC; só consulte outra vez se a reserva recusar o horário.\n'
      : '') +
    // Issue #831: consultar e encerrar o turno é o meio-caminho que deixa o lead sem
    // agendamento. Quando a ferramenta conjunta existe, ela é o caminho PREFERIDO —
    // confirmar o horário e gravar deixa de ser decisão de duas etapas do modelo.
    (tem('crm_find_and_book_appointment')
      ? 'Se o lead já disse DIA e HORA, use `crm_find_and_book_appointment`: ela ' +
        'confere a disponibilidade e grava o compromisso na MESMA chamada. Ela é o caminho preferido nesse caso ' +
        '— não consulte e pare por aí, deixando o lead sem horário marcado. Se o horário ' +
        'pedido não estiver livre, ela devolve os horários do dia; ofereça um deles ao lead.\n'
      : '') +
    'Checar e marcar horário com as ferramentas de agenda está SEMPRE dentro da sua ' +
    'autonomia quando essas ferramentas estão disponíveis para você — mesmo que as instruções da empresa ' +
    'peçam para encaminhar decisões fora da sua autonomia a um gerente/responsável nomeado (ex.: "fale com o ' +
    'Fulano"). Isso vale para OUTRAS decisões (desconto, exceção de política, algo que a ferramenta não ' +
    'cobre) — nunca para simplesmente consultar ou marcar um horário que a ferramenta resolve sozinha. NÃO ' +
    'diga "vou confirmar/verificar com [nome de pessoa/equipe]" para justificar não ter chamado a ferramenta: ' +
    'chame primeiro, e só fale de encaminhar a alguém se a ferramenta genuinamente não resolver.'
  );
}

/**
 * O mesmo ensino para quem CONSULTA a agenda e não marca.
 *
 * ⚠️ Este bloco existe porque o de cima nomeia `crm_book_appointment` em toda
 * frase, e há um arranjo legítimo e comum em que essa ferramenta não é dada ao
 * agente de propósito: o negócio quer que uma PESSOA confirme cada horário, e a
 * IA só consulta e registra o pedido. Clínica, salão, consultório.
 *
 * Antes desta divisão, esse agente não recebia bloco nenhum — a condição era
 * `toolIds.includes('crm_book_appointment')` — e ficava sem justamente a parte
 * que lhe cabe: não prometer "vou verificar e te aviso" sem ter consultado. Dar
 * a ele o bloco inteiro seria pior: ensinaria uma ferramenta que ele não tem, e
 * o modelo tentaria chamá-la.
 *
 * O que muda de conteúdo é só o desfecho: lá a checagem termina em marcar, aqui
 * termina em oferecer o horário e dizer, sem rodeio, que quem confirma é uma
 * pessoa. Isso não é hesitação — é o desenho do negócio, e o texto diz isso para
 * o modelo não confundir com incerteza dele.
 */
const AGENDA_CONSULTA_SYSTEM_BLOCK =
  '## Agenda — consulte antes de falar de horário\n' +
  'Se o lead mencionou (agora ou em qualquer mensagem anterior da conversa) um dia/horário ' +
  'específico que ainda não foi checado, chame crm_find_free_slots NESTE turno antes de responder. ' +
  'Não repita "vou verificar e te aviso" sem ter chamado a ferramenta — um "vou verificar" só é ' +
  'aceitável na MESMA resposta em que você já chamou e ela falhou ou não trouxe resultado.\n' +
  'Você NÃO tem ferramenta para marcar: quem confirma o horário é uma pessoa da equipe. Então ' +
  'NUNCA diga "confirmado", "está marcado", "reservei" ou equivalente — nem depois de o lead ' +
  'aceitar um horário que você ofereceu. Diga que vai passar para a equipe confirmar. Isso é como ' +
  'o negócio funciona, não uma limitação a esconder nem uma incerteza sua.\n' +
  'Consultar a agenda com crm_find_free_slots está SEMPRE dentro da sua autonomia — mesmo que as ' +
  'instruções da empresa peçam para encaminhar decisões a um responsável nomeado. Aquilo vale para ' +
  'OUTRAS decisões (desconto, exceção de política); nunca para simplesmente olhar quais horários ' +
  'existem. Não use "vou confirmar com [nome]" como desculpa para não ter consultado: consulte ' +
  'primeiro, e aí diga a quem passa.';

/**
 * O PRIMEIRO PASSO da cadeia de agenda, residente (#1019).
 *
 * ─── O que faltava, medido ──────────────────────────────────────────────────
 *
 * Os dois blocos acima nomeiam `crm_find_free_slots` em toda frase e
 * `crm_list_event_types` em NENHUMA. A cadeia de dois passos — listar os tipos,
 * pegar o `slug`, consultar os horários COM esse slug — existia só na
 * `description` da própria ferramenta, que é onde o modelo a lê por último e
 * sem o peso de uma instrução. Um agente com as três capacidades ligadas
 * chamava a lista e parava ali; o relato da issue mede 4 chamadas de lista com
 * o slug disponível e zero de `crm_find_free_slots` na sequência.
 *
 * ─── Por que este bloco é CONDICIONAL, e não texto fixo ─────────────────────
 *
 * Nomear `crm_list_event_types` para quem não a tem seria exatamente o erro que
 * a divisão dos outros dois blocos já evita (`AGENDA_CONSULTA_SYSTEM_BLOCK`:
 * "dar a ele o bloco inteiro seria pior — ensinaria uma ferramenta que ele não
 * tem, e o modelo tentaria chamá-la"). Por isso o bloco entra só quando o
 * agente tem as DUAS pontas: a lista e quem consome o slug.
 *
 * Ensino, não garantia: a garantia determinística é o `agendaStallGate`
 * (`before-send.ts`), que agora reconhece a promessa feita com o nome do
 * serviço. Os dois juntos é que fecham o caso — um ensina o caminho, o outro
 * impede que a resposta saia por fora dele.
 */
const AGENDA_CADEIA_SYSTEM_BLOCK =
  '## Agenda — os dois passos, no mesmo turno\n' +
  'Para falar de um horário REAL você precisa de duas coisas: o TIPO de atendimento (o `slug`) e os ' +
  'horários daquele tipo. Você tem `crm_list_event_types` para a primeira e `crm_find_free_slots` para ' +
  'a segunda — e o segundo passo PRECISA do `slug` que o primeiro devolve.\n' +
  'Se o lead pediu horário e você ainda não tem o `slug` do tipo (ou não sabe a qual tipo ele se ' +
  'refere), chame `crm_list_event_types` NESTE turno, escolha o tipo pelo que o lead descreveu e chame ' +
  '`crm_find_free_slots` com esse `slug` NO MESMO TURNO, antes de responder. Parar depois da lista e ' +
  'responder "vou verificar/organizar" é o defeito: a lista é o começo da conversa com a agenda, não a ' +
  'resposta. Se o tipo que o lead pediu não estiver na lista, diga isso a ele nomeando o que existe — ' +
  'não prometa verificar o que você já sabe que não tem.\n' +
  'Nunca invente um `slug`: ele vem da lista, escrito igualzinho.';

/**
 * Os blocos de agenda que ESTE agente recebe — a decisão num lugar só, testável.
 *
 * A régua é o que o agente TEM: os dois blocos de ensino nomeiam ferramentas, e
 * nomear uma ferramenta ausente faz o modelo tentar chamá-la.
 */
export function blocosDeAgendaResidentes(toolIds: readonly string[]): string[] {
  const blocos: string[] = [];
  // A regua de "quem marca" e a da main (#831): `temFerramentaDeMarcacao` conta
  // tambem `crm_find_and_book_appointment`, e o texto do bloco nomeia so as
  // ferramentas que ESTE agente tem — usar o texto fixo aqui desfaria a #831 no
  // caminho do turno.
  if (temFerramentaDeMarcacao(toolIds)) {
    blocos.push(agendaSystemBlock(toolIds));
  } else if (toolIds.includes('crm_find_free_slots')) {
    // Só consulta: o bloco de cima nomeia uma ferramenta que ele não tem.
    blocos.push(AGENDA_CONSULTA_SYSTEM_BLOCK);
  }
  if (
    toolIds.includes('crm_list_event_types') &&
    toolIds.includes('crm_find_free_slots')
  ) {
    blocos.push(AGENDA_CADEIA_SYSTEM_BLOCK);
  }
  return blocos;
}

/**
 * Tools de agenda cuja EXECUÇÃO neste turno arma o `agendaStallGate` (before-send.ts) —
 * ver o wrap no loop de montagem das tools MCP, mais abaixo.
 */
const AGENDA_TOOL_NAMES = new Set([
  'crm_find_free_slots',
  'crm_book_appointment',
  'crm_reschedule_appointment',
  // Issue #831: a ferramenta que consulta E marca numa chamada só. Ela EXECUTA
  // marcação, então precisa armar o mesmo gate: sem isto, o turno em que a IA
  // marcou passaria sem o `agendaStallGate` — o gate que existe justamente para
  // detectar "falou de agenda e nada foi gravado".
  'crm_find_and_book_appointment',
]);

/**
 * O agente consegue GRAVAR um horário sozinho (marcar ou remarcar)?
 *
 * Duas ferramentas MARCAM um horário novo: `crm_book_appointment` e, desde a issue
 * #831, a que consulta e marca numa chamada só (`crm_find_and_book_appointment`).
 * Ela decide QUAL bloco residente o agente recebe (`blocoResidenteDaAgenda`): o de
 * quem marca ou o de quem só consulta — divergindo, o bloco diria "você NÃO tem
 * ferramenta para marcar" a um agente que tem.
 *
 * O veto do gate NÃO lê esta função, e já leu: ele recebia um booleano
 * `podeMarcar` e escrevia uma lista fixa de ferramentas para todo agente que
 * marca — inclusive as que o agente não tem. Hoje ele recebe a lista exata
 * (`ferramentasDeAgendaDoAgente`).
 *
 * ⚠️ `crm_reschedule_appointment` está FORA, de propósito. Ela grava na agenda,
 * mas só MOVE um compromisso que já existe — não cria um. Incluí-la alargava o
 * portão além do que a #831 pede: o agente que tem só a remarcação (e que antes
 * caía no bloco de só-consulta) passava a receber o `agendaSystemBlock`, que
 * nomeia ferramentas de marcar que ele não tem — exatamente o modo de falha que
 * o bloco irmão existe para evitar, e que um dono aparando capacidades para caber
 * no teto de 25 tende a produzir.
 */
export function temFerramentaDeMarcacao(toolIds: readonly string[]): boolean {
  return (
    toolIds.includes('crm_book_appointment') ||
    toolIds.includes('crm_find_and_book_appointment')
  );
}

/**
 * O agente tem alguma ferramenta de agenda? É o que ARMA o `agendaStallGate`.
 *
 * Exportada porque o caminho de prévia (`preview.ts`) monta o mesmo contexto de
 * gate por conta própria, e as duas condições precisam ser a MESMA: se a prévia
 * armar diferente do turno real, quem afina o prompt testa contra um gate que não
 * é o que vai rodar — e o defeito aparece só com cliente na frente.
 */
export function temFerramentaDeAgenda(toolIds: readonly string[]): boolean {
  return toolIds.some((t) => AGENDA_TOOL_NAMES.has(t));
}

/**
 * As ferramentas de agenda que ESTE agente tem — a lista que o veto do
 * `agendaStallGate` nomeia.
 *
 * ⚠️ É a lista, e não um booleano, porque o texto do veto é ENSINO: ele diz ao
 * modelo o que chamar. Com `podeMarcar: boolean` o gate só sabia que o agente
 * marca, e nomeava a família inteira — `crm_book_appointment` para quem tem só a
 * conjunta, `crm_reschedule_appointment` para quem não remarca. Nomear ferramenta
 * ausente faz o modelo tentar chamá-la, e a correção vira um segundo defeito.
 */
export function ferramentasDeAgendaDoAgente(toolIds: readonly string[]): string[] {
  return [...AGENDA_TOOL_NAMES].filter((t) => toolIds.includes(t));
}

/**
 * QUAL bloco residente de Agenda este agente recebe — ou nenhum.
 *
 * A escolha vivia inline dentro de `executarTurnoDoAgente`, inalcançável sem o
 * runtime inteiro: nenhum teste chegava nela, e o portão que a #831 alargou
 * (`temFerramentaDeMarcacao`) só era exercitado pela própria função, nunca pelo
 * ponto de uso. Aqui ela é chamável — e o que se prende é o par
 * "quem recebe o bloco de marcar" × "quem recebe o de só consultar", que é
 * exatamente onde o texto ensina, ou não, uma ferramenta que o agente não tem.
 */
export function blocoResidenteDaAgenda(toolIds: readonly string[]): string | null {
  // Uma lei só: quem decide os blocos residentes da Agenda e
  // `blocosDeAgendaResidentes` — esta fatia (#1019) acrescentou a CADEIA de dois
  // passos como segundo bloco. Aqui fica o PRIMEIRO deles (o de marcar ou o de so
  // consultar), que e o par que o teste da #831 prende.
  return blocosDeAgendaResidentes(toolIds)[0] ?? null;
}

export interface InboundTurnKnobs {
  /** últimas N mensagens no contexto de abertura (LEAD_CONTEXT_HISTORY_LIMIT) */
  historyLimit: number;
  /** teto do payload do contexto (LEAD_CONTEXT_MAX_TOKENS) */
  maxContextTokens: number;
  /** orçamento fixo do índice de notas do lead injetado no sufixo (LEAD_NOTES_INDEX_MAX_TOKENS) */
  notesIndexMaxTokens: number;
  /** teto de steps do loop de tools por run (AGENT_MAX_STEPS) — circuit breaker fino é F2-15 */
  maxSteps: number;
  /**
   * Teto de mensagens FÍSICAS enviadas ao lead neste turno (MAX_SENDS_PER_TURN),
   * send_message + send_template somados, bolhas incluídas. Ausente = usa
   * `DEFAULT_MAX_SENDS_PER_TURN` — main.ts sempre o preenche pelo knob do env;
   * testes que não exercitam o teto o omitem sem custo.
   */
  maxSendsPerTurn?: number;
  /** atraso do reagendamento em veto/queued herdado da F2-06 (SEND_QUEUED_RETRY_MS) */
  queuedRetryDelayMs: number;
  /**
   * Teto da régua de resposta obsoleta (RESPOSTA_OBSOLETA_TETO_MS) — ver
   * `respostaFicouObsoleta`. Ausente = desligada (testes que não a exercitam).
   */
  respostaObsoletaTetoMs?: number;
  /** circuit breaker de tools por run (F2-15) — env TOOL_BREAKER_* */
  breaker: ToolBreakerThresholds;
  /**
   * Janela aceitável do follow-up agendado pela tool schedule_followup (F3-02).
   * Ausente = a tool NÃO é oferecida ao modelo neste run (main.ts sempre a preenche
   * pelos knobs do env; testes que não exercitam a tool a omitem sem custo).
   */
  followup?: FollowupWindowKnobs;
  /**
   * Compaction + flush pré-compaction (F3-07). Ausente = desligada (o turno usa o
   * transcript cru, capado por get_lead_context) — main.ts sempre a preenche pelos
   * knobs do env; testes que não a exercitam a omitem sem custo.
   */
  compaction?: CompactionKnobs;
  /**
   * Pruning de tool results antigos (F3-10). Ausente = desligado (as responseMessages do
   * run seguem íntegras na chamada de fechamento) — main.ts sempre o preenche pelos knobs
   * do env; testes que não o exercitam o omitem sem custo.
   */
  prune?: PruneToolResultsKnobs;
  /**
   * Skills situacionais (F3-09): gravação dos near-misses de matching como candidato ao
   * golden set. Ausente/false = misses NÃO gravados (o matching + injeção de corpo seguem
   * valendo) — main.ts sempre o preenche pelo env (`GOLDEN_CANDIDATES_ENABLED`); testes
   * que não querem linha no banco omitem a knob. Desde a #1695 a gravação é uma LINHA em
   * `golden_candidates` (só rótulo, sem texto de cliente), nunca arquivo em disco.
   */
  goldenCandidates?: boolean;
  /**
   * Stage-classifier por turno (F3-11; SalesGPT). Ausente = classificador NÃO roda (o
   * turno segue sem hint de estágio) — main.ts sempre o preenche pelo env; testes que não
   * o exercitam o omitem sem custo. A DIVERGÊNCIA classificador×modelo vira candidato em
   * `golden_candidates` (mesma knob da F3-09) — só se a knob estiver ligada.
   */
  stageClassifier?: StageClassifierKnobs;
  /**
   * Classifier anti-jailbreak no inbound do lead (F4-04; advisório). Ausente = NÃO roda (o
   * turno segue sem flag) — main.ts sempre o preenche pelo env; testes que não o exercitam o
   * omitem sem custo. Flag ALTA + tentativa de promessa fora de tabela (F4-01) no MESMO turno
   * escala para inbox_items (dedup por episódio).
   */
  jailbreak?: JailbreakClassifierKnobs;
  /**
   * Modo do gate de disclosure (F4-05; DISCLOSURE_MODE): 'inject' (default — o disclosure é
   * sempre adicionado à 1ª mensagem) ou 'veto' (bloqueia + ensina). Ausente = default 'inject'
   * do runBeforeSend. main.ts sempre o preenche pelo env.
   */
  disclosureMode?: DisclosureMode;
  /**
   * Camada SEMÂNTICA de promessa (F4-02) na cadeia before_send (gate 5 da ordem final F4-08).
   * Ausente = camada NÃO roda (o gate fica no-op) — testes que não a exercitam a omitem; main.ts
   * a preenche pelo env (PROMISE_SEMANTIC_*). `enabled=false` também mantém o gate no-op.
   * CUSTO: com enabled, é UMA chamada de modelo auxiliar POR TENTATIVA DE ENVIO (não por turno).
   */
  promiseSemantic?: { enabled: boolean; model?: string };
  /**
   * Onda 5 (Task 5.1) — modelo auxiliar dos turnos `classify`/`decide_timing` do
   * sistema de fluxos de follow-up (lib/agent-engine/agent/followup-flow-classify.ts).
   * Ausente = usa o defaultModel da org (mesma convenção de stageClassifier/jailbreak).
   */
  followupAi?: { model?: string };
  /**
   * Janela de validade da autorização de IA de um contato (gate opt-in
   * `channel_sessions.metadata.ai_gate = 'allowlist'`). Só consultada quando o
   * canal tem o gate ligado. Ausente nos testes que não o exercitam — o default
   * de 21 dias é aplicado.
   */
  allowlistTtlMs?: number;
}

/** Default de `allowlistTtlMs` (21 dias) para testes que omitem o knob. */
export const ALLOWLIST_TTL_MS_PADRAO = 21 * 24 * 60 * 60 * 1000;

export interface InboundTurnDeps {
  crmCfg: CrmEdgeConfig;
  llmCfg: LlmEdgeConfig;
  knobs: InboundTurnKnobs;
  log: Logger;
  /** testes: registry com provider fake — produção usa o default do seam */
  registry?: ProviderRegistry;
  embed?: typeof import('@/lib/ai/embed').embedText;
  /**
   * Seam de canal (F2-25): fábrica do ChannelAdapter para o pool do job. Default =
   * WAHA-via-CRM (o único adapter da v1). Trocar o adapter (ex.: Cloud API) NÃO
   * muda este handler — prova em daemon/test/channel-adapter.test.ts.
   */
  channel?: (pool: pg.Pool) => ChannelAdapter;
  /**
   * Relógio injetável (F2-13) — a janela horária do gate anti-ban é avaliada nele.
   * Default `() => new Date()`; os testes fixam um instante dentro da janela para
   * determinismo.
   */
  clock?: () => Date;
  /**
   * Espera do throttle da cadeia before_send (F2-13) — injetável só para teste.
   * Default = sleep real (runBeforeSend cai em `realSleep`). O E2E de fase (F2-18)
   * passa um spy que registra o waitMs sem esperar de verdade: torna o espaçamento
   * anti-ban observável no artefato de trace de forma determinística.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * O Jev no turno — na camada anti-manipulação e no roteador de intenção.
   * Injetável só para teste (chave e `fetch` dublês). Default = a chave da
   * organização e o egress com allowlist (`lib/ai/decisao/ponto.ts`).
   */
  jev?: DependenciasDoPonto;
}

/** Checkpoint mais recente do lead — a memória que atravessa sessões. */
export async function latestCheckpoint(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<LeadCheckpointRow | null> {
  const boundary = currentExecutionBoundary();
  const { rows } = await db.query<LeadCheckpointRow>(
    `select * from lead_checkpoints where organization_id=$1 and contact_id=$2
      ${boundary ? 'and conversation_id=$3 and service_revision=$4 and demanda_id is not distinct from $5::uuid and demanda_revision is not distinct from $6::bigint' : ''}
      order by seq desc limit 1`,
    boundary
      ? [
          tenantId,
          leadId,
          boundary.conversation_id,
          boundary.service_revision,
          boundary.demanda_id,
          boundary.demanda_revision,
        ]
      : [tenantId, leadId],
  );
  return rows[0] ?? null;
}

/**
 * O checkpoint DO TURNO indicado — não "o mais recente do lead".
 *
 * `latestCheckpoint` é a pergunta certa para ABRIR um turno e a errada para
 * PROCESSAR um: entre o fim do turno N e o claim do job do Operador N cabe o turno
 * N+1 inteiro. A fila ordena por `(priority, run_after)`, o job do Operador nasce
 * com `run_after = now()` e o inbound com `now() + INBOUND_DEBOUNCE_MS` (8s) —
 * então uma mensagem que chega enquanto o turno corrente fecha é servida ANTES, e o
 * Operador N acordaria lendo a declaração N+1. O efeito é a mesma promessa
 * executada duas vezes e um aviso aberto duas vezes para uma promessa só.
 *
 * A chave sempre viajou no payload (`origin_job_id`) e era usada só como campo de
 * log. Sem índice novo: `idx_lead_checkpoints_latest (organization_id, contact_id,
 * seq desc)` já restringe a varredura àquele lead, e o `job_id` filtra em cima.
 */
export async function checkpointDoJob(
  db: Queryable,
  tenantId: string,
  leadId: string,
  jobId: string,
): Promise<LeadCheckpointRow | null> {
  const { rows } = await db.query<LeadCheckpointRow>(
    `select * from lead_checkpoints
     where organization_id = $1 and contact_id = $2 and job_id = $3
     order by seq desc
     limit 1`,
    [tenantId, leadId, jobId],
  );
  return rows[0] ?? null;
}

/**
 * A decisão de ENFILEIRAR o Operador — irmã de `decidirSeRoda`, que decide se ele
 * RODA.
 *
 * A segunda era função pura desde o primeiro dia; a primeira ficou implícita em
 * "sempre". A decisão (e) da spec declarou o custo em dinheiro (+1 chamada com o
 * papel ligado) e ninguém declarou o custo em CAPACIDADE DE FILA, pago mesmo com o
 * papel desligado — o default de toda instalação.
 *
 * Por turno, para escrever uma linha de log num contêiner que o dono do negócio
 * nunca abre: um job, um slot de `QUEUE_MAX_CONCURRENCY` e a única vaga daquele
 * lead no lote do claim (`distinct on (coalesce(contact_id, id))`). Sob rajada, é o
 * turno de CRM sendo servido antes da próxima mensagem do cliente.
 *
 * O que se perde: o registro "papel_desligado" do handler. Aceitável — era um
 * `log.info` de worker, que este arquivo classifica como não-superfície, e a linha
 * do chamador o repõe no mesmo nível com custo zero de fila.
 *
 * O que isto NÃO conserta, e um leitor futuro vai supor que sim: com o papel
 * desligado, promessa feita pelo Conversador continua sem registro na Central. Era
 * assim antes e continua sendo.
 */
export function decidirSeEnfileiraOperador(input: {
  temAgentePublicado: boolean;
  papelLigado: boolean;
}): { enfileira: boolean; porque: 'ligado' | 'sem_agente' | 'papel_desligado' } {
  if (!input.temAgentePublicado) return { enfileira: false, porque: 'sem_agente' };
  if (!input.papelLigado) return { enfileira: false, porque: 'papel_desligado' };
  return { enfileira: true, porque: 'ligado' };
}

/**
 * A mensagem que acaba de chegar é uma fonte factual: se ela tem texto, o
 * agente não pode dizer ao cliente que ela veio vazia. Prompt reduz esse erro,
 * mas não é uma barreira de envio — o modelo ainda pode repetir um resumo
 * antigo contaminado. Esta detecção fica no único caminho que fala no canal.
 */
export function claimsCurrentInboundIsEmpty(candidate: string, currentInbound: string): boolean {
  if (currentInbound.trim() === '') return false;

  const emptyClaim = '(?:em\\s+branco|vazi[ao]|sem\\s+texto)';
  // ⚠️ `ela` NÃO entra aqui, e a razão está medida. Como pronome, ela casa com
  // qualquer sujeito feminino da frase — e "vazio" é palavra corrente numa
  // agenda. Num corpus de 6 frases legítimas de atendimento, a alternativa
  // vetava 1: "Consegui uma vaga com a Drª Mara — ela ficou com a tarde vazia na
  // quinta." O preço de tirá-la é não pegar a frase falsa escrita SÓ com
  // pronome ("ela veio vazia"); o preço de mantê-la era barrar atendimento
  // legítimo, e esse é o lado que cala o cliente. As seis frases estão no teste,
  // nomeadas — quem quiser alargar de novo alarga contra elas.
  const messageReference = '(?:mensagem|texto|recado|última\\s+mensagem)';
  return new RegExp(
    `\\b${messageReference}\\b[\\s\\S]{0,90}\\b${emptyClaim}\\b|\\b${emptyClaim}\\b[\\s\\S]{0,90}\\b${messageReference}\\b`,
    'i',
  ).test(candidate);
}

/**
 * Tudo que o cliente escreveu desde a última vez que ALGUÉM do nosso lado
 * respondeu — cada mensagem inteira, em ordem, nunca emendadas.
 *
 * ## Por que não basta "a última inbound"
 *
 * O drain COALESCE rajada: com `INBOUND_DEBOUNCE_MS` (default 8000), a segunda
 * mensagem do cliente não ganha job próprio — ela "entra de carona" no job da
 * primeira (`edge/crm/drain.ts`, "Coalescência"). O turno responde à mensagem que
 * o job aponta, e isso está certo; mas quem só olhasse essa mensagem não OUVIRIA
 * a segunda. Um cliente que escreve "oi" e, três segundos depois, "quero falar
 * com uma pessoa" tem que ser ouvido no segundo: calar um pedido de humano é
 * pior que o defeito que o pin do job veio consertar.
 *
 * ## Por que uma LISTA, e não um texto emendado
 *
 * `ehPalavraIsolada` (lib/opt-out/deteccao.ts) exige que a mensagem INTEIRA seja
 * a palavra-chave — é assim que "PARAR" descadastra e "tem como parar a dor?"
 * não. Emendar as mensagens da rajada num texto só destruiria exatamente essa
 * propriedade: "oi\nPARAR" não é palavra isolada, e o opt-out deixaria de
 * disparar. Quem consome isto roda o detector POR MENSAGEM.
 *
 * O corte é a última OUTBOUND (resposta de humano conta — ela também é do nosso
 * lado). Sem nenhuma outbound na janela, tudo que o cliente disse segue sem
 * resposta, e é isso que a lista devolve.
 */
export function inboundsNaoRespondidos(messages: readonly LeadContextMessage[]): string[] {
  const pendentes: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.direction === 'outbound') break;
    if (m.body.trim() !== '') pendentes.unshift(m.body);
  }
  return pendentes;
}

/**
 * Parâmetros do run que DIFEREM entre inbound (F2-09) e follow-up (F3-03): os ids
 * de envio (de fonte confiável — payload do drain no inbound, row do lead no
 * follow-up, nunca do payload do modelo) e a montagem da mensagem de abertura,
 * chamada DEPOIS do ritual de leitura (o follow-up injeta o bloco temporal aqui,
 * no SUFIXO — depois do prefixo cacheável, sem invalidar o cache F2-17).
 */
export interface AgentTurnInput {
  resolvedAgent?: TurnAgentResolution;
  /** número (channel_sessions.id do CRM) — chave da serialização anti-ban do envio. */
  channelSessionId: string;
  /** conversa do CRM — destino do send_message. */
  conversationId: string;
  /** Id da mensagem que criou o job inbound; não é usado por follow-ups. */
  inboundMessageId?: string;
  /** monta a abertura APÓS o ritual de leitura (inbound vs. bloco temporal do follow-up). */
  buildOpening: (ritual: {
    previous: LeadCheckpointRow | null;
    leadState: LeadStateRow | null;
    context: LeadContext;
    /** índice da memória do lead (F3-05), já dentro do orçamento; vai no sufixo. */
    notesIndexBlock: string;
    /**
     * Compromissos já marcados deste contato (issue #512).
     *
     * OPCIONAL pela mesma razão que `projeta`, e ela é externa ao desenho:
     * `tests/invariants/**` é congelado por hook de governança, e torná-lo
     * obrigatório forçaria a editar um invariante existente só para satisfazer
     * o compilador.
     */
    compromissosBlock?: string;
    /** O anúncio que o contato clicou (vazio = não veio de anúncio). */
    origemBlock?: string;
    /** Texto exato da mensagem que acordou este turno inbound. */
    currentInboundText?: string;
    /**
     * Projetar o contexto (spec 16 §4)? Decidido pelo turno, ver `turnoProjeta`.
     *
     * OPCIONAL no tipo, e a razão é externa ao desenho: `tests/invariants/**` é
     * congelado por hook de governança, e torná-lo obrigatório forçaria a editar
     * um invariante existente só para satisfazer o compilador — o que a catraca
     * proíbe, com razão. `runAgentTurn` SEMPRE o passa; o opcional só existe para
     * quem constrói um ritual à mão (testes).
     *
     * O custo está registrado: um chamador novo que esqueça o campo não projeta,
     * em silêncio. A direção do esquecimento é a segura (comportamento de hoje,
     * com o gate de saída cobrindo), mas é esquecimento mesmo assim.
     */
    projeta?: boolean;
    /** ferramentas que saíram para o Operador — o prompt não pode citá-las. */
    entregues?: readonly string[];
  }) => string;
  /**
   * A conversa está sob CONDUÇÃO da cadência (automática). Lida da conversa por
   * `createInboundTurnHandler` — nunca do payload. Com ela: allowlist do objetivo
   * nos dois pontos, anti-IDOR, funil só o da cadência, bloco do objetivo no
   * sufixo, contador de turnos e disclosure contado desde a abertura.
   */
  conducao?: ConducaoViva;
}

/**
 * Núcleo do run do agente, compartilhado por inbound_turn (F2-09) e followup_turn
 * (F3-03): ritual de abertura, loop de tools, fechamento com checkpoint e veto. Não
 * guarda NADA entre invocações — sessão fresca por job (todo estado no closure). O
 * que varia entre os dois tipos de turno vem em `input` (AgentTurnInput).
 */
/**
 * O aviso de que o agente atendeu SEM as capacidades configuradas.
 *
 * Vai para a Central de avisos (`agent_inbox_items`) porque é lá que o dono do
 * negócio olha — log de worker em VPS não é superfície de nada.
 *
 * Dedup por episódio ABERTO da organização (mesmo padrão do handoff): o defeito
 * é sistêmico, não por conversa, e uma retentativa em rajada viraria dezenas de
 * linhas idênticas — inbox inundado é inbox ignorado. Quem resolver o item e
 * vir o problema voltar recebe um item novo, que é o comportamento certo.
 *
 * Best-effort de propósito: se ATÉ o aviso falhar, o turno continua. Derrubar o
 * atendimento do cliente para reclamar de uma tool extra seria trocar um
 * problema pequeno por um grande.
 */
export async function avisarCapacidadesAusentes(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
  detalhe: string,
  log: Logger,
): Promise<void> {
  try {
    await db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'capabilities_missing', 'critical', $2, $3, 'conversation', $4
        where not exists (
          select 1 from agent_inbox_items
           where organization_id = $1 and kind = 'capabilities_missing' and status = 'open'
        )`,
      [
        tenantId,
        'O agente atendeu sem as capacidades que você ligou',
        'As ferramentas configuradas na tela do agente não puderam ser carregadas neste ' +
          'atendimento, e ele respondeu ao cliente sem elas. A conversa não foi interrompida. ' +
          `Motivo técnico: ${detalhe}`,
        conversationId,
      ],
    );
  } catch (err) {
    log.warn('aviso de capacidades ausentes não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/**
 * AS DETERMINÍSTICAS DO INBOUND, TAMBÉM ANTES DO RASCUNHO DO ASSISTIDO (#1648).
 *
 * O ramo assistido devolvia ANTES das detecções de STOP/opt-out e de pedido de
 * humano. Na prática o contato escrevia "pare de me mandar mensagem" e o bot
 * seguia elegível: sem silêncio durável (`force_human` +
 * `bot_silenced_until='infinity'`), sem cancelamento dos follow-ups agendados e
 * sem item de handoff na Central — só um rascunho na fila de aprovação, que
 * alguém podia nunca aprovar. Risco de LGPD: o pedido de parar ficava
 * dependendo de uma autorização humana que podia nunca vir, e quando ela vinha
 * o contato já tinha recebido mais mensagens no meio-tempo.
 *
 * Estas detecções são regex sobre o que o cliente ainda NÃO teve resposta — não
 * gastam token, não chamam modelo e não dependem do modo de operação. É por
 * isso que elas podem (e devem) rodar aqui, antes do desvio para
 * `generateReplyDraft`, com o MESMO mecanismo durável do caminho automático:
 *
 *   1. `avisarLeadDaEscalacao` PRIMEIRO — ordem obrigação, não estilo: o aviso
 *      tem de sair antes de `force_human` armar o gate que o vetaria;
 *   2. `performHumanHandoff` — silencia para sempre, cancela os crons
 *      pendentes, grava a passagem e abre (ou adenda) o item na Central.
 *
 * Idempotente, como lá: um retry re-executa tudo sem duplicar efeito. Devolve
 * `true` quando o turno foi silenciado — aí não há rascunho o que rascunhar e
 * nada mais pode sair nele.
 */
export async function deteccoesDeterministicasDoAssistido(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  args: {
    job: JobRow;
    tenantId: string;
    conversationId: string;
    channelSessionId: string;
    leadId: string;
    agent: PublishedAgentConfig;
    log: Logger;
    /**
     * Mensagem fixada no job — plano B quando a leitura do contexto do lead
     * falha. Um pedido de parar não pode virar "sem detecção" só porque o CRM
     * está fora do ar; a mensagem que acordou o turno é a mesma de sempre.
     */
    inboundMessageId?: string;
  },
): Promise<boolean> {
  const { job, tenantId, conversationId, channelSessionId, leadId, agent, log } = args;
  const clock = deps.clock ?? ((): Date => new Date());

  // O QUE O CLIENTE DISSE e ainda não foi respondido — a MESMA fonte do caminho
  // automático (`inboundsNaoRespondidos`): um pedido de parar que chegou na 2ª
  // mensagem de uma rajada não pode ser calado por ler só a última linha.
  let inboundsPendentes: string[] = [];
  let optedOutThisTurn = false;
  let lgpd: AvisoDeEscalacaoOpts['lgpd'];
  let contextoLido = false;
  try {
    const abertura = await getLeadContext(
      pool,
      deps.crmCfg,
      {
        tenantId,
        leadId,
        conversationId,
        fuso: await fusoDaOrganizacao(pool, tenantId, log),
      },
      { historyLimit: agent.historyMessageWindow, maxTokens: agent.historyTokenWindow },
    );
    if (abertura.ok) {
      contextoLido = true;
      inboundsPendentes = inboundsNaoRespondidos(abertura.context.messages);
      optedOutThisTurn = abertura.context.contact.is_blocked;
      lgpd = abertura.lgpd;
    } else {
      log.warn('modo assistido: contexto do lead não lido — detecção cai na mensagem fixada', {
        code: abertura.error.code,
      });
    }
  } catch (err) {
    log.warn('modo assistido: contexto do lead falhou — detecção cai na mensagem fixada', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
  // O plano B NUNCA sobrescreve o contexto lido: ele existe só quando a leitura
  // falhou, e aí a mensagem fixada no job é o que temos.
  if (!contextoLido && args.inboundMessageId !== undefined) {
    try {
      const fixada = await loadInboundBodyForJob(pool, {
        tenantId,
        conversationId,
        inboundMessageId: args.inboundMessageId,
      });
      if (fixada !== null && fixada.trim() !== '') inboundsPendentes = [fixada];
    } catch (err) {
      log.warn('modo assistido: mensagem fixada não lida — sem detecção neste turno', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
  }

  /** Args do aviso, montados NO MOMENTO do uso — o canal nasce só se algo casar. */
  const avisoDaEscalacao = (): {
    ids: AvisoDeEscalacaoIds;
    base: Omit<AvisoDeEscalacaoOpts, 'motivo'>;
  } => ({
    ids: {
      tenantId,
      leadId,
      conversationId,
      channelSessionId,
      jobId: job.id,
      jobClaim: claimOfJob(job),
    },
    base: {
      channel: deps.channel
        ? deps.channel(pool)
        : new WahaChannelAdapter(pool, { ...deps.crmCfg, agentActorId: agent.agentId }),
      optedOutThisTurn,
      // #2112: o TIPO do turno decide a janela do aviso — inbound/case respondem,
      // follow-up dispara. Mesmo discriminador do resto do turno (`eTurnoDeResposta`).
      origem: tipoDeEnvio(eTurnoDeResposta(job)),
      now: clock(),
      log,
      ...(lgpd !== undefined ? { lgpd } : {}),
      agentId: agent.agentId,
      ...(deps.knobs.disclosureMode !== undefined
        ? { disclosureMode: deps.knobs.disclosureMode }
        : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    },
  });

  // PLANO B SEM CONTEXTO = SEM `lgpd`: com ele nulo o gate de LGPD passa direto
  // (`before-send.ts`), e um contato anonimizado receberia o aviso. Nesse ramo o
  // aviso sai por `avisarLeadLendoOContato`, que lê o contato do banco.
  const semInsumosDoContexto = ({
    optedOutThisTurn: _bloqueado,
    lgpd: _lgpd,
    ...resto
  }: Omit<AvisoDeEscalacaoOpts, 'motivo'>): Omit<
    AvisoDeEscalacaoOpts,
    'motivo' | 'optedOutThisTurn' | 'lgpd'
  > => resto;

  if (
    inboundsPendentes.some(
      (texto) =>
        detectHumanHandoffRequest(texto) ||
        matchesHandoffKeyword(texto, agent.handoffKeywords),
    )
  ) {
    const briefing = montarBriefingDaPassagem({
      checkpoint: await latestCheckpoint(pool, tenantId, leadId),
      pendentesDoCliente: inboundsPendentes,
      motivo: { codigo: 'requested_human' },
    });
    const aviso = avisoDaEscalacao();
    const desfecho = contextoLido
      ? await avisarLeadDaEscalacao(pool, aviso.ids, { ...aviso.base, motivo: 'pediu_humano' })
      : await avisarLeadLendoOContato(pool, aviso.ids, {
          ...semInsumosDoContexto(aviso.base),
          motivo: 'pediu_humano',
        });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId },
      {
        reason: 'requested_human',
        conversationSummary: briefing.body,
        passagem: { origem: 'pedido_explicito', motivoCodigo: 'requested_human', briefing },
        avisoAoLead: desfecho,
        log,
      },
    );
    log.info(
      'handoff humano acionado por pedido explícito do lead (modo assistido, detecção determinística)',
      { kind: job.kind, lead_avisado: desfecho.avisado },
    );
    return true;
  }

  // STOP AMBÍGUO — o rascunho pendente NÃO segura este ramo: o pedido de parar
  // vale por si, e é ele que cancela os follow-ups agendados (LGPD #1648).
  if (inboundsPendentes.some((texto) => detectAmbiguousOptOut(texto))) {
    const briefing = montarBriefingDaPassagem({
      checkpoint: await latestCheckpoint(pool, tenantId, leadId),
      pendentesDoCliente: inboundsPendentes,
      motivo: { codigo: 'suspected_optout' },
    });
    const aviso = avisoDaEscalacao();
    const desfecho = contextoLido
      ? await avisarLeadDaEscalacao(pool, aviso.ids, { ...aviso.base, motivo: 'suspeita_de_opt_out' })
      : await avisarLeadLendoOContato(pool, aviso.ids, {
          ...semInsumosDoContexto(aviso.base),
          motivo: 'suspeita_de_opt_out',
        });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId },
      {
        reason: 'suspected_optout',
        conversationSummary: briefing.body,
        inboxTitle: 'Suspeita de opt-out — confirmar bloqueio do contato no CRM',
        passagem: { origem: 'opt_out_provavel', motivoCodigo: 'suspected_optout', briefing },
        avisoAoLead: desfecho,
        log,
      },
    );
    log.info(
      'possível opt-out detectado no modo assistido — bot silenciado, follow-ups cancelados e escalado ao humano',
      { kind: job.kind, lead_avisado: desfecho.avisado },
    );
    return true;
  }

  // Opt-out JÁ registrado na fonte (CRM): sem mensagem nova que casasse acima,
  // mas os crons podem ter nascido depois do bloqueio. Idempotente — o mesmo
  // cancel que o handoff acima compartilha (F4-07).
  if (optedOutThisTurn) {
    const canceled = await cancelPendingCronsForLead(pool, tenantId, leadId);
    if (canceled > 0) {
      log.info('opt-out já registrado — follow-ups agendados cancelados (modo assistido)', {
        canceled,
      });
    }
  }
  return false;
}

/**
 * O NÚCLEO DO TURNO, SEMPRE SOB A ESCOLTA DO ORÇAMENTO.
 *
 * Esta função é o único ponto do produto por onde os três kinds de turno de
 * lead passam (`inbound_turn`, `followup_turn`, `case_reply_turn` — quatro call
 * sites), e por isso é aqui que a escolta mora. Envolver o turno INTEIRO, e não
 * as chamadas de modelo, é o que faz a proteção alcançar as chamadas indiretas
 * (`classifyStage`, `maybeCompact`/flush) — que são justamente as PRIMEIRAS do
 * turno, e portanto as que estouram primeiro quando o teto acabou. Ver o
 * cabeçalho de `comHandoffSeOrcamentoAcabar` para o defeito medido.
 *
 * `executarTurnoDoAgente` NÃO é exportada de propósito: exportá-la criaria um
 * caminho para o turno rodar desescoltado, e a guarda de artefato
 * (`tests/unit/handoff-por-orcamento.test.ts`) conta exatamente um call site.
 */
export async function runAgentTurn(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  input: AgentTurnInput,
): Promise<void> {
  const leadIdDoJob = job.contact_id;
  if (leadIdDoJob === null) {
    throw new Error('job de turno sem contact_id — o CHECK da fila deveria impedir');
  }
  const logDaEscolta = withFields(deps.log, {
    job_id: job.id,
    tenant_id: job.organization_id,
    lead_id: leadIdDoJob,
  });
  await comHandoffSeOrcamentoAcabar(
    {
      pool,
      tenantId: job.organization_id,
      leadId: leadIdDoJob,
      conversationId: input.conversationId,
      briefingDoCheckpoint: () =>
        briefingDoCheckpointDuravel(pool, job.organization_id, leadIdDoJob, logDaEscolta),
      // O canal nasce DENTRO da closure: instanciá-lo aqui faria todo turno feliz
      // pagar por um adapter que só o caminho de erro usa. Sem `agentActorId` de
      // propósito — quando o teto estoura antes da primeira chamada, não houve
      // agente resolvido para creditar.
      avisarLead: () =>
        avisarLeadLendoOContato(
          pool,
          {
            tenantId: job.organization_id,
            leadId: leadIdDoJob,
            conversationId: input.conversationId,
            channelSessionId: input.channelSessionId,
            jobId: job.id,
          },
          {
            motivo: 'orcamento_de_ia',
            channel: (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(
              pool,
            ),
            // #2112: a escolta roda no turno INTEIRO, inclusive num follow-up —
            // o tipo do turno é o que diz qual janela o gate do aviso avalia.
            origem: tipoDeEnvio(eTurnoDeResposta(job)),
            now: deps.clock?.() ?? new Date(),
            log: logDaEscolta,
            ...(deps.knobs.disclosureMode !== undefined
              ? { disclosureMode: deps.knobs.disclosureMode }
              : {}),
            ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
          },
        ),
      log: logDaEscolta,
    },
    () => executarTurnoDoAgente(deps, job, pool, ctx, input),
  );
}

/**
 * Este turno termina em mensagem PARA O LEAD? Só esses são adiados pela janela
 * anti-ban — adiar os outros seria parar trabalho interno por causa de um
 * horário que não é dele.
 *
 *   * `inbound_turn` / `case_reply_turn` — respondem o cliente, sempre.
 *   * `followup_turn` — só com `purpose: 'send_message'`. Os outros dois
 *     propósitos do fluxo (`classify`, `plan_timing`) são leitura e
 *     planejamento: não abrem o WhatsApp de ninguém.
 *   * `operator_turn` — retaguarda (mexe no funil), nunca fala com o lead.
 */
/**
 * ═══ RESPOSTA vs RETOMADA — a distinção que a janela da 0495 faz ═══
 *
 * `turnoVaiFalarComOLead` admite `followup_turn`, que RETOMA conversa parada — e
 * retomar NÃO é responder: abrir `followup_turn` junto faria o número mandar
 * "e aí, tudo certo?" às 4h para quem dormiu.
 *
 * Só a REAÇÃO a uma mensagem recebida lê a janela de resposta. `case_reply_turn`
 * entra porque responde a um caso em aberto: ninguém "chama" um caso, o caso chama.
 */
export function eTurnoDeResposta(job: Pick<JobRow, 'kind'>): boolean {
  return job.kind === 'inbound_turn' || job.kind === 'case_reply_turn';
}

export function turnoVaiFalarComOLead(job: JobRow): boolean {
  if (job.kind === 'inbound_turn' || job.kind === 'case_reply_turn') return true;
  if (job.kind !== 'followup_turn') return false;
  const purpose = (job.payload as { purpose?: unknown } | null)?.purpose;
  return purpose === undefined || purpose === 'send_message';
}

async function executarTurnoDoAgente(
  deps: InboundTurnDeps,
  job: JobRow | null,
  pool: pg.Pool,
  ctx: { workerId: string },
  input: AgentTurnInput,
  preview?: TurnPreview,
): Promise<void> {
  const liveJob = (): JobRow => {
    if (!job) throw new Error('preview_operational_job_forbidden');
    return job;
  };
  const tenantId = preview?.organizationId ?? liveJob().organization_id;
  // Empty exists only in the in-memory scenario. Every CRM read uses preview's
  // context and all operational tools are replaced before entering the loop.
  const leadId = preview?.contactId ?? (preview ? '' : liveJob().contact_id);
  if (leadId === null) throw new Error('turn_without_contact');
  // O RELÓGIO, declarado antes de qualquer guarda de janela.
  //
  // Ele já existia — 330 linhas ABAIXO, depois das duas guardas que mais
  // dependem dele. O contrato de `InboundTurnDeps.clock` diz "a janela horária
  // do gate anti-ban é avaliada nele", e as duas guardas chamavam `new Date()`
  // cru: o relógio injetado não alcançava justamente o que ele existe para
  // fixar. Em produção dá no mesmo; no CI, a hora real do runner decidia, e a
  // suíte de invariantes ficava vermelha das 22h às 7h (fuso do tenant) — nove
  // horas por dia em que um PR reprova por causa do relógio de parede.
  const clock = deps.clock ?? ((): Date => new Date());
  const inicioDoProcessamento = performance.now();
  const contextKnobs = {
    historyLimit: deps.knobs.historyLimit,
    maxTokens: deps.knobs.maxContextTokens,
  };
  // Contexto do RUN em toda linha de log do turno (F2-16): job_id É o run id.
  const runLog = withFields(deps.log, {
    job_id: job?.id ?? null,
    preview_run_id: preview?.runId,
    tenant_id: tenantId,
    lead_id: leadId,
  });

  // F2 — portões de entrada (ADR-0006, S1): handoff, elegibilidade e janela anti-ban.
  const portoes = await avaliarPortoesDeEntrada({
    deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob,
  });
  if (!portoes.seguir) return;
  const { camadas, fusoDaOrg } = portoes.valor;

  // F3 — roteamento e configuração do agente (ADR-0006, S4): roteador, assistido, pausado,
  // horário de atendimento, condução, decisão do roteador e destino do card.
  const roteamento = await resolverRoteamentoDoTurno({
    deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob,
  });
  if (!roteamento.seguir) return;
  const { routed, agentConfig, agentOperation } = roteamento.valor;
  // F4 — contexto e system prompt (ADR-0006, S2): leituras da abertura e montagem do `system`.
  const {
    maxSteps, argsAux, turnContextKnobs, skills, currentInboundText, previous, leadState, system, openingContext,
  } = await carregarContextoDoTurno(
    { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob },
    { agentConfig, contextKnobs, fusoDaOrg },
  );

  // F5 — desvios determinísticos (ADR-0006, S5): canal, STOP, LGPD, pedido de humano e opt-out.
  const desvios = await tratarDesviosDeterministicos(
    { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob },
    { agentConfig, agentOperation, currentInboundText, previous, openingContext },
  );
  if (!desvios.seguir) return;
  const { channel, liveChannel, optedOutThisTurn, lgpd, avisoDaEscalacao, mensagemDoJob, inboundsPendentes } =
    desvios.valor;
  // Apaga a renovação do "digitando…" (ver `manterDigitando`). Começa como no-op:
  // turno de preview ou de retaguarda nunca acende, e parar o que não acendeu é nada.
  let pararDigitando: () => void = () => {};

  // F6 — preparo do contexto (ADR-0006, S5): roteiro, compactação, blocos auxiliares e crons do opt-out.
  const { roteiro, effectivePrevious, effectiveContext, notesIndexBlock, compromissosBlock, origemBlock } =
    await prepararContextoDoTurno(
      { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob },
      { routed, argsAux, currentInboundText, previous, openingContext, optedOutThisTurn },
    );

  // Estado do turno (ADR-0006, D4): o MESMO objeto para as ferramentas, `send_message`
  // e as fases de depois do modelo. Nasce aqui, uma vez; nenhum módulo de fase cria o seu.
  const estado = criarEstadoDoTurno();
  // Teto de mensagens físicas por turno (F2-15b) — `seq` JÁ é a contagem certa: ele só
  // avança quando o envio de fato sai pro canal (send_message + send_template, bolhas
  // incluídas), nunca em veto de gate. Checar `seq` antes de tentar o próximo envio
  // barra o modelo sem gastar uma chamada de before-send à toa.
  const maxSendsPerTurn = deps.knobs.maxSendsPerTurn ?? DEFAULT_MAX_SENDS_PER_TURN;
  // F4-04: a tabela de promessa versionada do tenant (F4-01), carregada uma vez para
  // correlacionar tentativa de promessa fora de tabela com o sinal de jailbreak — a
  // detecção NÃO depende do gate estar na cadeia default (a ordem final é da F4-08).
  const promiseTable = (await loadPromiseTable(pool, tenantId))?.table ?? null;
  // Falha fechada: sem saber o tipo da fonte, nenhum trecho de conhecimento prova
  // oferta, e a conferência de promessa age como agia antes das evidências.
  const fontesQueProvamOferta = await carregarFontesQueProvamOferta(
    pool,
    tenantId,
    agentConfig?.knowledgeSourceIds ?? [],
  ).catch((err: unknown) => {
    runLog.warn('tipos das fontes de conhecimento indisponíveis — nenhum trecho prova oferta', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return [];
  });
  const evidenciasComerciais = criarEvidenciasComerciaisDoTurno(fontesQueProvamOferta);
  const recuperarEvidencias = criarRecuperadorDeEvidencias(pool, {
    tenantId,
    fontes: fontesQueProvamOferta,
    registrar: evidenciasComerciais.registrarConhecimento,
    log: runLog,
  });
  // Gate 5 da cadeia (F4-02/F4-08): closure do classificador semântico com tenant/lead/job da
  // ROW do job fechados dentro (regra dura nº 1) — resolvido pelo seam agnóstico. undefined =
  // camada off (gate no-op). CUSTO: uma chamada de modelo POR ENVIO quando ligada.
  //
  // Memo POR CORPO e por evidências, por turno (`memoizarPorCandidata`): os
  // fail-safes de vocabulário e de promessa re-rodam a cadeia com o MESMO texto.
  const classificadorMemoizado = camadaLigada(
    camadas.promessa_semantica,
    deps.knobs.promiseSemantic?.enabled === true,
  )
    ? memoizarPorCandidata((candidate: string) =>
        classifyPromise(
          pool,
          deps.llmCfg,
          { tenantId, leadId: leadId || null, jobId: job?.id },
          {
            candidate,
            commercialEvidence: evidenciasComerciais.ler(candidate),
            conversationContext: montarContextoDaRevisao(
              effectiveContext.messages, effectivePrevious?.rolling_summary,
              (deps.clock?.() ?? new Date()).toISOString(), fusoDaOrg,
            ),
            ...argsAux(deps.knobs.promiseSemantic?.model),
          },
          { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
        ),
        // As evidências crescem entre o veto e o reenvio; o veredito de antes
        // da consulta não vale para a mesma frase depois dela.
        () => evidenciasComerciais.contexto(),
      )
    : undefined;
  const semanticClassifier = classificadorMemoizado === undefined ? undefined : async (candidate: string) => {
    await recuperarEvidencias(candidate);
    return classificadorMemoizado(candidate);
  };
  // Conferência de fato (#2231): a TERCEIRA camada do before_send, depois da
  // F4-01/F4-02. A evidência é lida NA HORA (nasce no meio do turno) e a
  // chamada tem UMA requisição por turno fechada aqui: os re-runs dos
  // fail-safes reaproveitam o resultado em cache, sem pagar de novo.
  const conferirAfirmacoes = criarConferidorDeAfirmacoes(
    createAdminClient(),
    {
      organizationId: tenantId,
      conversationId: input.conversationId || null,
      contactId: leadId || null,
      agentId: agentConfig?.agentId ?? null,
      lerEvidencias: () => evidenciasComerciais.ler(),
      // #2923 — o RUN que mediu: o job no turno automático, o RASCUNHO na prévia
      // (é o que o `runId` da prévia já carrega). É o ponteiro que a resposta
      // aprovada usa para fechar a linha que a prévia deixou em aberto.
      runId: job?.id ?? preview?.runId ?? null,
      // Na prévia o rascunho AINDA NÃO saiu: a linha nasce "sem par" de propósito
      // (o cartão só conta o que chegou ao cliente), e quem a fecha é a resposta
      // aprovada. No turno automático o par nasce fechado, como sempre.
      rotuloAtual: preview ? null : 'enviado',
    },
    deps.jev ?? {},
  );
  // Knobs de atraso humano por conexão (0499) — lidos UMA vez por turno para a
  // pausa antes da 1ª bolha (`esperarComoHumano`) e para o jitter entre bolhas
  // (`throttle_ms + jitter_max_ms`). Sem linha em channel_knobs caem nos defaults
  // de defaults.ts — que espelham os valores históricos (regressão zero).
  const pacingDoTurno = !preview
    ? await loadChannelKnobs(pool, tenantId, input.channelSessionId, runLog)
    : null;
  const knobsDeAtrasoHumano = {
    atrasoNotarMs: pacingDoTurno?.knobs.atrasoNotarMs,
    msPorCaractere: pacingDoTurno?.knobs.msPorCaractere,
    atrasoMinimoMs: pacingDoTurno?.knobs.atrasoMinimoMs,
    atrasoMaximoMs: pacingDoTurno?.knobs.atrasoMaximoMs,
  };
  // Lido por função: atribuído numa closure, comparar a variável direto estreita o tipo
  // para `null` e quebra o `if (pacingCapVeto !== null …)` do fim do turno.
  const capDeEnvioAtingido = (): boolean => estado.pacingCapVeto !== null;
  // Best-effort: move o lead pra etapa `crm_stages.slug='chamar-humano'` do pipeline
  // dele (se o tenant tiver criado essa etapa — opt-in, ver `lib/leads/handoff-stage-move.ts`)
  // sempre que um caso humano abre neste turno, deliberado (open_human_case) ou pelo
  // fail-safe do `case_promise`. Sem isto, o funil no CRM não refletia o handoff que o
  // PRÓPRIO PROMPT do tenant promete ao lead ("vou verificar/encaminhar com o Fulano")
  // — medido num tenant de produção: caso aberto, funil parado em "Novo contato".
  // Nunca bloqueia nem derruba o turno — mesma disciplina de `triggerHandoff` (G1-G4),
  // que já chama o mesmo helper para o handoff por palavra-chave do cliente.
  const moverParaHandoffBestEffort = (reason: string): void => {
    moverLeadParaEtapaDeHandoff(createAdminClient(), {
      organizationId: tenantId,
      leadId,
      reason,
    }).catch((err) => {
      runLog.warn('moverLeadParaEtapaDeHandoff falhou (best-effort, caso humano)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  const noteRunError = (err: Error): void => {
    estado.runError ??= err;
  };

  // Guideline-matching if-then (F3-09): o SINAL do turno (última mensagem inbound) decide
  // quais skills disparam. Corpos casados vão no SUFIXO da abertura (situacional, por-lead —
  // depois do prefixo cacheável); situação neutra ⇒ nenhum corpo (economia de tokens). Os
  // near-misses (probe sem hard-match) viram candidatos ao golden set, gravados como LINHA
  // em `golden_candidates` (sem texto de cliente, issue #1695) — só com a knob ligada.
  // Calculado AQUI, ANTES de
  // montar rawTools (Fase 2): o gate de read_skill_reference precisa do resultado do match
  // para decidir se a tool entra no turno (mesmo padrão de gate de search_knowledge/
  // request_human_handoff, feito antes do wrapToolsWithBreaker).
  // Sinal do matcher com o CONTEXTO recente (não só a última mensagem): a
  // conversa sobre motos continua e a skill não pode "cair" quando o cliente
  // responde a escolha ("A 2025"), senão as fotos da moto escolhida não saem.
  //
  // SÓ o matcher lê a janela. `skillSignal` segue sendo a ÚLTIMA inbound: ele
  // também alimenta o classificador de jailbreak e os candidatos de divergência
  // de estágio, e uma tentativa de jailbreak de cinco mensagens atrás não pode
  // seguir marcando todo turno seguinte.
  const skillSignal = latestInboundSignal(effectiveContext.messages);
  const sinalDoMatcher = recentInboundSignal(effectiveContext.messages);
  const skillMatch = matchSkills(skills, sinalDoMatcher);
  // Skills que o roteiro puxa neste passo entram JUNTO do match por palavra
  // (o nó `skill` diz "puxe isto aqui"). O match vence o empate por nome.
  const skillsDoRoteiro = (roteiro?.skills ?? [])
    .map((nome) => skills.find((sk) => sk.name === nome))
    .filter((sk): sk is (typeof skills)[number] => sk !== undefined)
    .filter((sk) => !skillMatch.matched.some((m) => m.name === sk.name));
  const matchedSkillsBlock = renderMatchedSkillBodies([...skillMatch.matched, ...skillsDoRoteiro]);
  if (!preview && deps.knobs.goldenCandidates === true) {
    await recordSkillMissCandidates(
      pool,
      {
        tenantId,
        leadId,
        jobId: liveJob().id,
        candidates: skillMatch.missCandidates,
      },
      runLog,
    );
  }
  // Fase 2: telemetria de ativação de skill (hard match + near-miss probe).
  if (!preview) {
    try {
      const rows: Array<[string, string | null, string]> = [
        ...skillMatch.matched.map(
          (s) => [s.name, s.versionId, 'hard'] as [string, string | null, string],
        ),
        ...skillMatch.missCandidates.map(
          (m) => [m.skill, null, 'probe'] as [string, string | null, string],
        ),
      ];
      if (rows.length > 0) {
        const values: string[] = [];
        const params: unknown[] = [];
        rows.forEach(([name, verId, trig], i) => {
          const b = i * 5;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
          params.push(tenantId, name, verId, trig, liveJob().id);
        });
        await pool.query(
          `insert into skill_activations (organization_id, skill_name, skill_version_id, trigger, job_id) values ${values.join(',')}`,
          params,
        );
      }
    } catch (err) {
      runLog.warn('skill_activations não gravadas', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  /**
   * Os ids de catálogo que de fato ENTRARAM neste turno — não os que a tela
   * marcou. A diferença importa: quando a montagem falha, o turno segue sem elas,
   * e é o turno REAL que decide se a projeção arma. Ler a config aqui faria a
   * projeção ficar desligada num turno que, por acidente, não recebeu ferramenta
   * nenhuma — justo o turno em que ela é gratuita.
   *
   * Declarado ANTES de `rawTools` de propósito: o `execute` de `get_lead_context`
   * fecha sobre ele e o lê no momento da CHAMADA, quando as ferramentas de
   * catálogo já foram montadas (o `push` acontece bem abaixo, antes do loop do
   * modelo). Deixá-lo declarado depois funcionaria, mas esconderia a ordem de que
   * a correção depende.
   */
  const mcpToolIdsDoTurno: string[] = [];

  // O que as ferramentas movidas para `turno/ferramentas/` leem de F1 (ADR-0006, S6).
  const contextoDasFerramentas = { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob };

  const rawTools: ToolSet = {
    get_lead_context: criarGetLeadContext(contextoDasFerramentas, { fusoDaOrg, turnContextKnobs, mcpToolIdsDoTurno, noteRunError }),
    send_template: tool({
      ...AGENT_TOOL_DEFS.send_template,
      execute: async ({ template_name, language, values }) => {
        estado.tentativasDeEnvio += 1;
        if (estado.seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${estado.seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
        // O texto RENDERIZADO vai como `body` da cadeia: os gates de promessa,
        // spinning e disclosure avaliam exatamente o que o contato vai ler. Sem
        // isso, "usar template" seria a forma de escapar dos guardrails de conteúdo.
        // A definição DESTA conexão (lib/channels/linha-do-espelho.ts): sem o
        // escopo, com canal oficial e parceiro espelhando o mesmo nome, o agente
        // renderizava e passava pelos gates o texto de OUTRO número.
        const linha =
          (await definicaoNaConexao<{
            components: unknown;
            parameter_format: string;
            status: string;
          }>(pool, ['components', 'parameter_format', 'status'], {
            organizationId: tenantId,
            name: template_name,
            language,
            channelSessionId: input.channelSessionId,
          })) ?? undefined;
        if (linha === undefined) {
          return {
            ok: false,
            error: {
              code: 'template_desconhecido',
              message:
                `não existe template "${template_name}" em ${language} nesta conta. ` +
                'Encerre o turno; um humano precisa configurá-lo.',
            },
          };
        }
        // "Existe" não é "pode ser disparado". A regra vive em template-binding.ts e
        // o caminho HUMANO já a respeitava (recusa `not_approved` no menu do composer);
        // este caminho não a consultava — e é o que age SEM humano olhando. Um template
        // PENDING ou REJECTED iria à Graph API, voltaria erro genérico, e o modelo
        // trataria como falha de infraestrutura em vez de configuração pendente.
        //
        // Erro SEPARADO de `template_desconhecido` de propósito: as duas causas pedem
        // ações humanas diferentes — criar o template, ou esperar/consertar a análise
        // da Meta. Colapsá-las manda o operador procurar no lugar errado.
        if (!isStatusSendable(linha.status)) {
          return {
            ok: false,
            error: {
              code: 'template_nao_aprovado',
              message:
                `o template "${template_name}" existe mas está ${linha.status} na Meta — ` +
                'só um template APPROVED pode ser disparado. Encerre o turno; ' +
                'um humano precisa resolver a aprovação.',
            },
          };
        }

        const rendered = renderTemplateBody(linha.components, values, {
          name: template_name,
          language,
          parameterFormat: linha.parameter_format,
        });

        const chain = await runBeforeSend({
          pool,
          log: runLog,
          agentOperation,
          tenantId,
          leadId,
          jobId: liveJob().id,
          channelSessionId: input.channelSessionId,
          body: rendered,
          // Só ESTE gate muda; stop, LGPD e pacing continuam valendo integralmente.
          isTemplate: true,
          optedOutThisTurn,
          // Resposta do turno, mesmo sendo template: lê a janela de resposta (0495).
          resposta: eTurnoDeResposta(liveJob()),
          crmDailyLimit: null,
          now: clock(),
          sleep: deps.sleep,
          lgpd,
          send: (finalBody: string) => {
            pararDigitando(); // a mensagem sai agora; renovar depois dela mentiria
            estado.seq += 1;
            return liveChannel().send({
              tenantId,
              leadId,
              jobId: liveJob().id,
              jobClaim: claimOfJob(liveJob()),
              agentOperation,
              seq: estado.seq,
              conversationId: input.conversationId,
              body: finalBody,
              template: { name: template_name, language, values },
            });
          },
        });

        if (chain.status === 'vetoed') {
          return { ok: false, error: { code: chain.code, message: chain.message } };
        }
        const outcome = chain.outcome;
        estado.outcomes.push(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'already_sent') {
          return {
            ok: true,
            status: 'enviada',
            message_id: outcome.messageId,
            // Explícito: sem isso o modelo tende a emendar texto livre depois do
            // template — que a janela fechada recusaria.
            message: 'template enviado. Não escreva mais nada neste turno.',
          };
        }
        return { ok: true, status: 'aceita_aguardando_canal' };
      },
    }),
    search_knowledge: criarSearchKnowledge(contextoDasFerramentas, { agentConfig, evidenciasComerciais, mcpToolIdsDoTurno }, estado),
    send_message: tool({
      ...AGENT_TOOL_DEFS.send_message,
      execute: async ({ body: corpoDoModelo, produto_codigo }) => {
        estado.tentativasDeEnvio += 1;
        // O texto sai no formato do WhatsApp — sem `\n` literal nem
        // `**negrito**` de Markdown na tela do cliente. Antes de qualquer gate,
        // para que o corpo vazio, as bolhas e a pausa humana meçam o que sai.
        // Ver `formato-whatsapp.ts`.
        const body = formatarParaWhatsApp(corpoDoModelo);
        // CORPO VAZIO NÃO SAI. Medido ao vivo (2026-09-19): o `gpt-4o-mini`
        // chamou `send_message` várias vezes com corpo que virou vazio e o
        // WhatsApp do cliente recebeu bolhas em branco. O schema garante
        // min(1) no argumento, mas um `\n`/espaço passa e vira vazio depois do
        // trim/gates. Recusar aqui devolve ao modelo para reescrever — nunca
        // manda bolha em branco.
        if (body.trim() === '') {
          return {
            ok: false,
            error: {
              code: 'corpo_vazio',
              message:
                'O texto da mensagem ficou vazio. Escreva a resposta de verdade e chame send_message de novo.',
            },
          };
        }
        // DUPLICATA PRÓXIMA NO MESMO TURNO (near-dup): o corpo é quase idêntico a algo
        // que JÁ foi aceito e enviado NESTE turno, ou que está EM VOO agora (tool calls
        // paralelas do mesmo passo — a reserva vira logo abaixo, antes do primeiro
        // await; a candidata checada ainda não foi reservada, então nunca se suprime
        // a si mesma). O contrato é UMA resposta adequada e completa — repetição
        // imediata é redundância, não informação nova (mudança de valor/negação é
        // exceção na régua: preço, hora ou "não" trocado passam, ver near-dup.ts).
        // Suprime sem tocar no canal nem no ledger (nada é marcado como entregue),
        // devolvendo ao modelo um erro de ENSINO (mesma forma de corpo_vazio/
        // resposta_obsoleta). Cobre o caminho de recuperação do turno mudo: a
        // correção re-entra por aqui, na janela em memória. Bolhas de UM
        // send_message não se comparam entre si (só candidato contra candidato),
        // então fatiamento legítimo não se autossuprime.
        const corpoRepetido = estado.dupTrava.checar(body);
        if (corpoRepetido !== null) {
          runLog.info('duplicate_suppressed — candidato quase idêntico ao já aceito no turno', {
            job_id: job?.id ?? null,
            prior_len: corpoRepetido.length,
            candidato_len: body.length,
          });
          // RASTRO PARA O OPERADOR (#2996, item 7): suprimir sem registrar é
          // silêncio invisível na timeline — quem opera precisa ver que o agente
          // DECIDIU não falar e por quê. Mesmo vocabulário do veto de guardrail
          // (`send_vetoed`), motivo legível pela `vetoReason` (sem código cru na
          // tela), metadados SÓ ids e tamanhos — nunca o conteúdo da mensagem
          // (PII: a linha aparece na tela e no export LGPD). Sem lastro (a
          // supressão acontece ANTES da cadeia, não existe trace) a linha entra
          // como 'system' com `actor_agent_id` — regra da própria 0071. Try/catch:
          // a timeline não pode derrubar a recusa que ela descreve.
          try {
            const roteou = await emitAgentActivityForContact({
              pool,
              organizationId: tenantId,
              contactId: leadId,
              type: 'send_vetoed',
              sourceModule: 'near-dup',
              sourceId: job?.id ?? null,
              ...(agentConfig?.agentId ? { agentId: agentConfig.agentId } : {}),
              reason: vetoReason('near_dup', 'duplicate_suppressed'),
              payload: {
                gate: 'near_dup',
                code: 'duplicate_suppressed',
                conversation_id: input.conversationId,
                prior_len: corpoRepetido.length,
                candidato_len: body.length,
              },
            });
            if (!roteou.routed) {
              runLog.warn('supressão near-dup não roteada na timeline do negócio', {
                reason: roteou.reason,
              });
            }
          } catch (err) {
            runLog.warn('atividade da supressão near-dup não gravada', {
              error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
            });
          }
          return {
            ok: false,
            error: {
              code: 'duplicate_suppressed',
              message:
                'Você já enviou uma mensagem muito parecida a esta nesta conversa, depois da última fala do cliente — ela NÃO foi reenviada. ' +
                'Não repita a mesma informação. Se há algo genuinamente novo a acrescentar, envie SÓ a parte nova; ' +
                'senão encerre o turno agora.',
            },
          };
        }
        if (claimsCurrentInboundIsEmpty(body, mensagemDoJob)) {
          estado.vetos.falseEmptyInbound += 1;
          if (estado.vetos.falseEmptyInbound < MAX_VETOS_DE_FALSO_VAZIO) {
            return {
              ok: false,
              error: {
                code: 'false_empty_inbound',
                message:
                  'O cliente enviou texto nesta mensagem. Não diga que ela veio vazia, em branco ou sem texto. ' +
                  `Responda ao pedido real agora: ${JSON.stringify(mensagemDoJob)}. ` +
                  `Esta é a tentativa de correção ${estado.vetos.falseEmptyInbound}.`,
              },
            };
          }
          // Não há segunda cadeia a re-rodar aqui (diferente do vocabulário
          // interno, que desarma um gate e chama `runBeforeSend` de novo): esta
          // barreira é local ao `execute`, então soltar é seguir para o resto do
          // caminho de envio, com a cadeia inteira ainda pela frente.
          runLog.warn('fail-safe do gate de falso-vazio: envio liberado após vetos seguidos', {
            vetos: estado.vetos.falseEmptyInbound,
          });
        }
        if (estado.seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${estado.seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
        // RESERVA EM VOO (#2996, item 6): do gate até aqui o CAMINHO DE PASSAGEM
        // é tudo síncrono (nenhuma operação assíncrona entre `checar` e
        // `reservar`; o único ponto que cede o event loop mora no ramo de
        // supressão, que termina em return), então check-then-reserve é atômico
        // no event loop — a próxima chamada paralela do passo só roda depois
        // desta tick e vê a reserva. Daqui até o `finally` da cadeia esta
        // candidata vale como "em envio": três send_message quase idênticos num
        // mesmo passo não passam todos pela checagem. Veto/falha/exceção removem
        // a reserva (os `liberar` explícitos + o `finally`); envio aceito
        // PROMOVE para a memória durável (exatamente uma vez, em `promover`).
        // JANELA PRÉ-CADEIA COM DONO (revisão do #2996, item 6): as duas
        // consultas de antes da cadeia — a de resposta obsoleta e a de preparo
        // de fotos — não têm catch próprio; uma exceção delas escaparia por
        // CIMA do `finally` da cadeia e deixaria a reserva órfã em `emVoo`,
        // suprimindo depois a re-tentativa legítima da candidata que nunca saiu
        // (no provedor com chave de reserva da assinatura, o turno até re-entra
        // no modelo e esbarra nela). Este bloco envolve a reserva e as duas
        // consultas: em exceção ele SOLTA a reserva e RE-LANÇA o erro original
        // intacto — sem traduzir para `internal_error`, sem mudar classificação
        // nem desfecho do turno; só o vazamento deixa de existir. Os `liberar`
        // dos returns estruturados seguem valendo (return não passa por catch).
        // `let` das fotos declarado antes do bloco porque o escopo precisa
        // alcançar a cadeia; envolver a reserva não altera o caminho do gate —
        // ele segue inteiramente síncrono do `checar` até a reserva.
        let fotosDoProduto: FotoParaEnvio[] = [];
        let fotosQueFaltaram = 0;
        try {
          estado.dupTrava.reservar(body);
          // RESPOSTA OBSOLETA: o cliente escreveu de novo enquanto este turno pensava.
          // Só antes do PRIMEIRO envio — cortar a meio uma resposta já começada é pior
          // que a duplicata. A mensagem nova tem job próprio, que lê a conversa inteira
          // e responde a tudo de uma vez. Ver `respostaFicouObsoleta`.
          if (
            !preview &&
            estado.seq === 0 &&
            (await respostaFicouObsoleta(
              pool,
              { organizationId: tenantId, conversationId: input.conversationId, jobId: liveJob().id },
              deps.knobs.respostaObsoletaTetoMs ?? 0,
            ))
          ) {
            runLog.info('resposta descartada — o cliente escreveu de novo durante o turno', {
              job_id: liveJob().id,
              conversation_id: input.conversationId,
            });
            // #1943: marca o turno como descartado. NADA mais sai dele, nem a
            // pergunta pendente do roteiro — ela segue feita para o turno da
            // mensagem nova. Ver `perguntaDoRoteiroPodeSair` no `enviar`.
            estado.turnoDescartado = true;
            // Nada saiu: a reserva em voo não pode virar memória (nem sobreviver
            // ao turno como entrada órfã). #2996, item 6.
            estado.dupTrava.liberar(body);
            return {
              ok: false,
              error: {
                code: 'resposta_obsoleta',
                message:
                  'O cliente mandou mensagem nova enquanto você escrevia; esta resposta ficou desatualizada e NÃO foi enviada. ' +
                  'NÃO chame send_message de novo neste turno — encerre agora. O próximo turno lê a conversa inteira e responde a tudo de uma vez.',
              },
            };
          }
          // A foto do produto (ideia de @vgamkt, #1130): preparada ANTES da cadeia e
          // fora do lock do número — a cópia no Storage é rede. Código errado volta
          // ao modelo sem enviar nada; foto que não copiou sai do envio e o texto
          // segue (degradar para só texto). Ver `agent/fotos-do-produto.ts`.
          if (produto_codigo !== undefined && produto_codigo.trim() !== '' && !preview) {
            const preparadas = await prepararFotosDoProduto(pool, copiarFotoNoStorage(runLog), {
              tenantId,
              conversationId: input.conversationId,
              codigo: produto_codigo,
            });
            if (!preparadas.ok) {
              // Nada saiu: libera a reserva antes de devolver o erro ao modelo.
              estado.dupTrava.liberar(body);
              return { ok: false, error: { code: preparadas.code, message: preparadas.message } };
            }
            fotosDoProduto = preparadas.fotos;
            fotosQueFaltaram = preparadas.tinha - preparadas.fotos.length;
          }
          // F4-04: sinaliza (independente do gate F4-01/F4-08) se ESTA candidata é uma
          // promessa fora de tabela — usado só para correlacionar com o jailbreak no fim do
          // turno. A detecção é determinística (decidePromise); sem tabela do tenant = no-op.
          if (
            promiseTable !== null &&
            !decidePromise({ candidate: body, table: promiseTable }).allow
          ) {
            estado.outOfTablePromiseAttempted = true;
          }
        } catch (err) {
          // EXCEÇÃO PRÉ-CADEIA (revisão do #2996, item 6): nada saiu — a reserva
          // órfã sai junto e o erro sobe idêntico ao de antes (nenhum code novo,
          // nenhum return inventado). `liberar` é idempotente: se um caminho já
          // tiver liberado, aqui é no-op.
          estado.dupTrava.liberar(body);
          throw err;
        }
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
          const beforeSendArgs = {
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
              disponivel: rawTools.schedule_followup !== undefined,
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
          switch (outcome.kind) {
            case 'sent':
            case 'already_sent':
              return {
                ok: true,
                status: 'enviada',
                message_id: outcome.messageId,
                ...(produto_codigo !== undefined ? { fotos_enviadas: fotosDoProduto.length } : {}),
                ...(fotosQueFaltaram > 0
                  ? {
                      aviso: `${fotosQueFaltaram} foto(s) do produto não puderam ser enviadas; o texto foi. Não diga ao cliente que mandou essas fotos.`,
                    }
                  : {}),
              };
            case 'queued':
              return {
                ok: true,
                status: 'aceita_aguardando_canal',
                message:
                  'o canal aceitou a mensagem e vai enviá-la quando a sessão voltar — não reenvie.',
              };
            case 'blocked':
              return {
                ok: false,
                error: {
                  code: 'contato_bloqueado',
                  message:
                    'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
                },
              };
            case 'failed':
              return {
                ok: false,
                error: {
                  code: 'envio_falhou',
                  message:
                    'o canal falhou ao enviar — não tente de novo neste turno; o sistema fará retry.',
                },
              };
            case 'unavailable':
              // transiente (transporte/tool do canal): ensina o modelo a parar; o
              // job re-tenta com a MESMA idempotency_key (ledger ficou 'requested').
              noteRunError(
                new Error(
                  `canal indisponível no envio (${outcome.reason}) — job re-tentado pela fila`,
                ),
              );
              return {
                ok: false,
                error: {
                  code: 'envio_indisponivel',
                  message:
                    'não consegui enviar agora (canal indisponível) — encerre o turno; o sistema re-tentará.',
                },
              };
          }
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
      },
    }),
    update_lead_state: criarUpdateLeadState(contextoDasFerramentas, { agentConfig, noteRunError }, estado),
    save_lead_note: criarSaveLeadNote(contextoDasFerramentas, { noteRunError }),
    get_lead_note: criarGetLeadNote(contextoDasFerramentas, { noteRunError }),
    request_human_handoff: criarRequestHumanHandoff(contextoDasFerramentas, { pararDigitando: () => pararDigitando(), avisoDaEscalacao, previous, inboundsPendentes, noteRunError }, estado),
  };

  // F3-02: a tool nativa só entra com janela configurada e callback habilitado
  // na versão publicada. Tenant/lead vêm da ROW do job (closure), nunca do
  // payload do modelo. É MUTANTE (cria cron_job), por isso fica fora de
  // READ_ONLY_TOOLS.
  const followupKnobs = deps.knobs.followup;
  if (podeExporScheduleFollowup(agentConfig?.followup, followupKnobs)) {
    rawTools.schedule_followup = criarScheduleFollowup(contextoDasFerramentas, { followupKnobs, agentConfig, noteRunError }, estado);
  }

  // Fase 2 (Task 6): read_skill_reference só entra quando alguma skill CASADA neste
  // turno carrega references no manifesto (Task 3) — sem isso oferecer a tool seria
  // ruído. Read-only (tool-breaker.ts); tenant/matched skills vêm do closure
  // (skillMatch, calculado acima), nunca do payload do modelo.
  if (skillMatch.matched.some((s) => skillHasReferences(s))) {
    rawTools.read_skill_reference = criarReadSkillReference(contextoDasFerramentas, { skillMatch, noteRunError });
  }

  // Fase 2B: a tela pode DESLIGAR a tool de handoff do modelo (a detecção
  // determinística de pedido de humano continua ativa — guardrail nunca sai).
  if (agentConfig !== null && !agentConfig.handoffToolEnabled) {
    delete rawTools.request_human_handoff;
  }

  // #2156 — a chave por ASSUNTO JURÍDICO mora AO LADO da irmã que desliga a
  // ferramenta, mas faz o contrário: não remove nada. A ferramenta continua
  // no modelo e só a descrição troca pela que não manda passar por "questão
  // jurídica" — a pessoa que pede "quero falar com alguém" e as palavras-chave
  // que o dono escreveu continuam intocados (outros guardrails, outro fim).
  // Com a chave ligada (ou ausente em fixture antiga) não há o que trocar:
  // `AGENT_TOOL_DEFS` já carrega a descrição ligada. A lógica mora em
  // `aplicaAChaveDeAssuntoJuridico` para o teste do turno exercitá-la fora do
  // turno (tests/unit/chave-juridico-so-troca-a-descricao.test.ts).
  aplicaAChaveDeAssuntoJuridico(rawTools, agentConfig?.handoffLegalEnabled);

  // Spec 15: snapshot mínimo do contexto disponível pro humano que for atender o
  // caso — campo de CONVENIÊNCIA pra UI, não load-bearing (nada aqui é relido pelo
  // agente). ponytail: snapshot mínimo; enriquecer se a UI precisar de mais.
  const buildCaseContextSnapshot = (): Record<string, unknown> => ({
    contact_name: effectiveContext.contact.name,
    last_messages: effectiveContext.messages
      .slice(-5)
      .map((m) => ({ direction: m.direction, body: m.body })),
  });

  // Spec 15 (Wave 3a): tools de caso humano (open_human_case/provide_case_update) só
  // entram quando a tela habilita (cases_enabled) — mesmo padrão do handoff acima.
  // Ids do closure (row do job), nunca do payload; payload inválido é erro de ENSINO
  // ({ok:false}), exceção real vira internal_error (mesma disciplina dos irmãos).
  if (agentConfig !== null && agentConfig.casesEnabled) {
    rawTools.open_human_case = criarOpenHumanCase(contextoDasFerramentas, { agentConfig, buildCaseContextSnapshot, moverParaHandoffBestEffort, noteRunError }, estado);
    rawTools.provide_case_update = criarProvideCaseUpdate(contextoDasFerramentas, { noteRunError });
  }

  // A tool de conhecimento só entra quando o agente publicado tem material para
  // consultar. Desde a 0181 isso é a lista de materiais escolhida na tela; o
  // ponteiro legado (`activeKbVersionId`) segue valendo para o clone que ainda
  // não aplicou a migration. Ferramenta que só sabe responder "não tenho base"
  // não é neutra: gasta contexto e degrada a escolha do modelo.
  if (
    (agentConfig?.knowledgeSourceIds?.length ?? 0) === 0 &&
    agentConfig?.activeKbVersionId == null
  ) {
    delete rawTools.search_knowledge;
  }

  // A ferramenta de template só entra em canal que EXIGE template fora da janela.
  // Num canal que fala livre a qualquer hora ela nunca teria uso — e tool inútil no
  // prompt não é neutra: gasta contexto e degrada a escolha do modelo.
  {
    const provider =
      preview && !preview.channelId
        ? DEFAULT_CHANNEL_PROVIDER
        : await loadChannelProvider(pool, tenantId, input.channelSessionId);
    if (!capabilitiesOf(provider).requiresTemplates) {
      delete rawTools.send_template;
    }
  }

  // 2B-tools: tools do catálogo MCP habilitadas NA TELA entram no run (audit +
  // role/scope da ponte nativa; envio e handoff do catálogo são bloqueados —
  // ver edge/crm/mcp-tools.ts). As 8 tools do engine têm precedência de nome.
  let mcpCleanup: (() => Promise<void>) | null = null;
  try {
    // "digitando…" do INÍCIO do trabalho até a 1ª bolha, renovado a cada 10s.
    // Antes ele acendia uma vez, só na chamada principal ao modelo: os
    // classificadores auxiliares, a conexão MCP e a conferência de promessa
    // rodavam sem indicador, e numa resposta de ~1 min o WhatsApp apagava o
    // único sinal no meio do caminho. Só em turno que fala com o lead: turno
    // de retaguarda não abre o WhatsApp de ninguém.
    if (channel?.signalTyping && turnoVaiFalarComOLead(liveJob())) {
      pararDigitando = manterDigitando(
        () => channel.signalTyping!({ tenantId, conversationId: input.conversationId }),
        runLog,
      );
    }
    if (agentConfig !== null && agentConfig.toolIds.length > 0) {
      try {
        // As de OPERAÇÃO saem antes de serem montadas, quando o Operador as tem.
        // Medido: são elas que carregavam 2 dos 3 vazamentos (o DADO que devolvem),
        // e tirá-las levou a taxa de 30% para 10% — ver RELATORIO-passo6.md.
        const catalogoEntregue = catalogoEntregueAoOperador({
          operadorLigado: agentConfig.operatorEnabled,
          ferramentasDoOperador: agentConfig.operatorToolIds,
          ferramentasDoConversador: agentConfig.toolIds,
        });
        const configSemOperador =
          catalogoEntregue.length === 0
            ? agentConfig
            : {
                ...agentConfig,
                toolIds: agentConfig.toolIds.filter((t) => !catalogoEntregue.includes(t)),
              };
        // Ponto 1 da allowlist da condução: ferramentas ∩ objetivo, funis ∩ o da
        // cadência. Idempotente com a restrição que o handler já aplicou.
        const conducaoDoTurno = input.conducao ?? preview?.conducao;
        const configDoTurno = conducaoDoTurno
          ? restringirConfigAConducao(configSemOperador, conducaoDoTurno)
          : configSemOperador;
        if (catalogoEntregue.length > 0) {
          runLog.info('capacidades de catálogo entregues ao operador', {
            entregues: catalogoEntregue,
          });
        }
        const mcp = await buildMcpTurnTools(
          deps.crmCfg,
          {
            organizationId: tenantId,
            jobId: preview?.runId ?? liveJob().id,
            contactId: leadId || null,
            conversationId: input.conversationId,
          },
          configDoTurno,
          runLog,
          preview ? { readOnly: true } : undefined,
        );
        if (mcp !== null) {
          mcpCleanup = mcp.cleanup;
          for (const [name, mcpTool] of Object.entries(mcp.tools)) {
            if (name in rawTools) continue;
            if (
              (name === 'crm_search_products' || name === 'crm_search_knowledge') &&
              typeof mcpTool.execute === 'function'
            ) {
              const executeOriginal = mcpTool.execute.bind(mcpTool);
              rawTools[name] = {
                ...mcpTool,
                execute: (async (...args: Parameters<typeof executeOriginal>) => {
                  const resultado = await executeOriginal(...args);
                  // O modelo escolhe a consulta, nunca fornece a autorização.
                  // A ponte MCP já aplica organização, papel e escopo de leitura.
                  if (name === 'crm_search_products') evidenciasComerciais.registrarCatalogo(resultado);
                  else evidenciasComerciais.registrarConhecimento(resultado);
                  return resultado;
                }) as typeof mcpTool.execute,
              };
              continue;
            }
            // Marca a EXECUÇÃO (não só a decisão de chamar) — é isso que o agendaStallGate
            // precisa saber para não vetar um turno que já checou a agenda de verdade.
            if (AGENDA_TOOL_NAMES.has(name) && typeof mcpTool.execute === 'function') {
              const executeOriginal = mcpTool.execute.bind(mcpTool);
              rawTools[name] = {
                ...mcpTool,
                execute: (async (...args: Parameters<typeof executeOriginal>) => {
                  estado.agendaToolCalledThisTurn = true;
                  return executeOriginal(...args);
                }) as typeof mcpTool.execute,
              };
            } else {
              rawTools[name] = mcpTool;
            }
          }
          mcpToolIdsDoTurno.push(...mcp.toolIds);
          runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
        }
      } catch (err) {
        // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
        // derruba o turno — a conversa do cliente não pode morrer porque uma tool
        // extra falhou. Isso continua certo.
        //
        // O que estava errado era o DEPOIS. A versão anterior deste comentário
        // dizia "o humano vê o log". Não vê: o log sai no stdout do worker, num
        // contêiner de VPS que o dono do negócio nunca abre. Medido num turno
        // real — o agente atendeu sem NENHUMA das capacidades que o humano tinha
        // ligado na tela, e a única pista existia num log que ninguém lê. É
        // falha-em-verde: anunciada na tela, ausente na execução, nada contando.
        const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        runLog.error('tools MCP da tela não montadas — turno segue sem elas', { error: detalhe });
        if (preview)
          preview.result.impediments.push({
            code: 'capabilities_unavailable',
            message: 'Não foi possível carregar as capacidades configuradas.',
          });
        else await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
      }
    }

    // ── A CURA (spec 16, passo 6) ───────────────────────────────────────────────
    //
    // As ferramentas de escrita saem do Conversador quando o Operador as assumiu.
    // O gate de vazamento é rede — barra na saída e ensina; isto é a cura: o
    // modelo não pode repetir o nome de uma ferramenta que nunca viu, e foi pelo
    // NOME que o vazamento voltou depois de a descrição ser limpa.
    //
    // A remoção é CONDICIONAL a o novo dono existir (ver entrega-de-capacidade):
    // tirar de um lado sem garantir o outro não separa papéis, perde capacidade.
    const entregues = capacidadesEntreguesAoOperador({
      operadorLigado: agentConfig?.operatorEnabled ?? false,
      ferramentasDoOperador: agentConfig?.operatorToolIds ?? [],
    });
    for (const nome of entregues) delete rawTools[nome];
    if (entregues.length > 0) {
      runLog.info('capacidades entregues ao operador — fora do turno do conversador', {
        entregues,
      });
    }

    // Ponto 2 da allowlist da condução + anti-IDOR, ANTES da política de preview
    // (no assistido o rascunho vê exatamente o que o automático veria). Fica só
    // o que o objetivo permite, e toda ferramenta recusa ids de outra pessoa.
    const conducaoDasTools = input.conducao ?? preview?.conducao;
    if (conducaoDasTools) {
      const alvo = conducaoDasTools;
      const filtradas = restringirAConducao(filtrarRawTools(rawTools, alvo.preset), {
        leadId: alvo.lead_id,
        contactId: alvo.contact_id,
        conversationId: alvo.conversation_id,
        agendamentoEhDaConducao: async (appointmentId) => {
          const { rows } = await pool.query<{ ok: boolean }>(
            `select true as ok from calendar_appointments
              where organization_id = $1 and id = $2 and contact_id = $3`,
            [tenantId, appointmentId, alvo.contact_id],
          );
          return rows.length > 0;
        },
      });
      for (const nome of Object.keys(rawTools)) delete rawTools[nome];
      Object.assign(rawTools, filtradas);
      runLog.info('ferramentas restritas à condução da cadência', {
        conducao_id: alvo.id,
        ferramentas: Object.keys(rawTools),
      });
    }

    // Circuit breaker de tools (F2-15): estado no closure DESTA invocação — zera
    // entre runs por construção (mesma garantia de isolamento do resto do run).
    if (preview && rawTools.get_lead_note)
      rawTools.get_lead_note = {
        ...rawTools.get_lead_note,
        execute: async () => ({ ok: true, notes: preview.notes ?? [] }),
      };
    const previewContext = preview
      ? await previewGateContext(pool, preview, runLog, clock())
      : null;
    const previewTools =
      preview && previewContext
        ? applyPreviewPolicy(
            rawTools,
            preview,
            {
              ...previewContext,
              disclosure: {
                ...previewContext.disclosure,
                mode: deps.knobs.disclosureMode ?? 'inject',
              },
            },
            () => estado.pendingCitations,
            semanticClassifier,
            () => ({
              agenda: {
                active: previewContext.agenda?.active ?? false,
                ferramentas: previewContext.agenda?.ferramentas ?? [],
                toolCalledThisTurn: estado.agendaToolCalledThisTurn,
              },
            }),
            // #2490 — a MESMA `prepararFotosDoProduto` do caminho de produção,
            // com a MESMA cópia por service role e a MESMA query no catálogo:
            // a prévia só troca o destino, a pasta `dry-run` da organização em vez
            // da conversa: anexo em pasta de conversa seria efeito no cliente —
            // proibido no preview. Vale para o sandbox e para o rascunho assistido
            // (que tem conversa, mas não pode anexar nela). A pasta é permanente:
            // o nome da cópia é determinístico, então repetir o teste não duplica.
            // Nada é enviado: o `send_message` da prévia nem chega perto do canal.
            (codigo: string) =>
              prepararFotosDoProduto(pool, copiarFotoNoStorage(runLog), {
                tenantId,
                conversationId: PASTA_DE_TESTE_DE_MIDIA,
                codigo,
              }),
            // #2923 — a conferência de fato do turno entra na prévia: o mesmo
            // conferidor criado acima, com as evidências que as ferramentas
            // consultaram NESTE turno. É ele que grava a observação e que faz um
            // `contradiz`/`nao_esta_na_base` aparecer para quem revisa o rascunho
            // (impedimento no assistido, aviso no Teste) em vez de sair calado.
            conferirAfirmacoes,
          )
        : rawTools;
    const tools = wrapToolsWithBreaker(previewTools, {
      thresholds: deps.knobs.breaker,
      readOnlyTools: READ_ONLY_TOOLS,
      log: runLog, // os warns dos gates do breaker saem carimbados com o run
    });

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

    // Spec 16 §4: a projeção arma quando NENHUMA ferramenta de catálogo entrou —
    // é exatamente o turno em que os ids do contexto não têm uso, e portanto o
    // único em que removê-los não custa nada. Logado porque "por que o prompt
    // deste turno é diferente do daquele?" precisa ter resposta no trace.
    const projetaContexto = turnoProjeta(mcpToolIdsDoTurno);
    runLog.info('projeção do contexto do turno', {
      projeta: projetaContexto,
      mcp_tools_no_turno: mcpToolIdsDoTurno.length,
    });
    const openingBase = input.buildOpening({
      previous: effectivePrevious,
      leadState,
      context: effectiveContext,
      notesIndexBlock,
      projeta: projetaContexto,
      entregues,
      compromissosBlock,
      origemBlock,
      ...(currentInboundText !== null ? { currentInboundText } : {}),
    });
    // Sufixos por-lead (situacionais, voláteis — depois do prefixo cacheável F2-17): corpos de
    // skill casadas (F3-09) + hint do classificador (F3-11) + instrução de split (F4-xx, quando
    // split_messages está on — Onda 4). Vazios são omitidos.
    const splitHint = instrucaoDeBolhas(agentConfig?.splitMessages ?? false);
    // Spec 15: o `case_id` real do caso 'awaiting_lead' desta conversa, se houver — sem
    // isso o modelo nunca consegue chamar provide_case_update quando o lead simplesmente
    // responde (o caminho comum; case_reply_turn só cobre a AÇÃO do humano). Sufixo
    // por-lead (volátil) — nunca no prefixo cacheável (o case_id muda a cada caso).
    const caseAwaitingLead =
      preview?.kind !== 'sandbox' && agentConfig !== null && agentConfig.casesEnabled
        ? await getCaseAwaitingLead(pool, tenantId, input.conversationId)
        : null;
    const caseAwaitingLeadBlock =
      caseAwaitingLead !== null
        ? `## Caso aguardando resposta deste cliente\n` +
          `Há um caso aberto (case_id: ${caseAwaitingLead.id}) esperando uma informação dele: "${caseAwaitingLead.ask}". ` +
          `Se a mensagem dele responde a isso, chame provide_case_update com este case_id e a informação recebida — ` +
          `NÃO diga que já repassou/avisou o responsável sem chamar a tool.`
        : '';
    // ── O RELÓGIO DO TURNO ────────────────────────────────────────────────────
    //
    // Entra AQUI, e o lugar é a metade do conserto.
    //
    // No `system` (o prefixo estável org-wide, F2-17) ele invalidaria o cache de
    // prompt de TODOS os leads a cada turno, porque muda a cada segundo — é o que
    // `stable-prefix.ts` proíbe em letra. No sufixo por-lead ele é volátil entre
    // iguais, e custa os ~50 tokens dele.
    //
    // PRIMEIRO da lista de propósito: a âncora temporal precede o material que o
    // modelo vai usar para decidir data — corpo de skill, hint do classificador,
    // caso pendente. E `executarTurnoDoAgente` é o ponto por onde passam os TRÊS
    // turnos conversacionais (inbound, follow-up e resposta a caso), então um
    // ponto só cobre os três — e alcança de carona a chamada de fechamento, que
    // reusa `openingTextOnly` e é onde nasce o `prazo` ISO da declaração.
    const agoraBlock = renderAgora(clock(), fusoDaOrg);
    // O objetivo da condução da cadência vai no SUFIXO por lead, nunca no
    // `system`: muda por conversa e invalidaria o prefixo cacheável da org.
    const conducaoDoPrompt = input.conducao ?? preview?.conducao;
    const conducaoBlock = conducaoDoPrompt
      ? blocoDaConducao(
          conducaoDoPrompt,
          await nomeDaEtapa(pool, tenantId, conducaoDoPrompt.etapa_alvo_id),
        )
      : '';
    const openingSuffixes = [
      agoraBlock,
      conducaoBlock,
      matchedSkillsBlock,
      stageHintBlock,
      splitHint,
      caseAwaitingLeadBlock,
      roteiro?.bloco ?? '',
      preview?.feedback ? '## Revisão humana deste atendimento\n' + preview.feedback : '',
    ].filter((b) => b !== '');
    const openingText =
      openingSuffixes.length === 0
        ? openingBase
        : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`;
    // Onda 3 (aprimoramento): mídia inbound recente vira part nativa (image/file) SÓ para
    // provider+modelo capazes (T2 modelCapabilities) — modelo incapaz/desconhecido → [] e o
    // derivado textual (já embutido em openingText via LeadContextMessage) cobre sozinho.
    const nativeParts =
      preview?.kind === 'sandbox'
        ? []
        : await buildNativeMediaParts({
            messages: effectiveContext.messages,
            provider: agentConfig?.provider ?? 'anthropic',
            model: agentConfig?.model ?? '',
            multimodalInput: agentConfig?.multimodalInput ?? false,
            admin: deps.crmCfg.supabase,
          });
    const openingTextOnly: ModelMessage[] = [{ role: 'user', content: openingText }];
    const openingMessages: ModelMessage[] =
      nativeParts.length === 0
        ? openingTextOnly
        : [{ role: 'user', content: [{ type: 'text', text: openingText }, ...nativeParts] }];

    // MEMÓRIA DE DUPLICATA CRUZADA (near-dup): semeia a régua com o que JÁ saiu
    // para esta conversa desde a última inbound do cliente. Num turno fresco que
    // responde mensagem NOVA a janela está vazia (nada saiu depois dela), então
    // nada legítimo é suprimido; num follow-up de promessa que re-responde uma
    // conversa CALADA a janela está cheia e a re-resposta quase idêntica é
    // suprimida — a redundância de follow-up medida em produção. Não-fatal: banco
    // indisponível → degrada para a memória só-do-turno (dedup parcial melhor que
    // turno derrubado).
    //
    // `!preview &&` idem à guarda irmã (linha ~2052): em preview `job` é null e
    // `liveJob()` LANÇA `preview_operational_job_forbidden` — o seeding derrubava
    // o `runAgentPreview` inteiro (#2996, item 1).
    if (!preview && turnoVaiFalarComOLead(liveJob())) {
      try {
        const jaDito = await corposEnviadosDesdeUltimaInbound(pool, {
          organizationId: tenantId,
          conversationId: input.conversationId,
        });
        if (jaDito.length > 0) {
          estado.dupTrava.semear(jaDito);
        }
      } catch (err) {
        runLog.warn('memória de duplicata não carregada — dedup cai só para o turno', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
        });
      }
    }

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

    // TURNO MUDO: o turno de resposta terminou sem mensagem ao cliente e sem
    // nenhuma razão para o silêncio (`turno-mudo.ts`). UMA correção, com a mesma
    // conversa e as mesmas ferramentas: o envio passa pela cadeia inteira, como
    // qualquer outro. O fechamento lê a fita das DUAS chamadas.
    let mensagensDoTurno: ModelMessage[] = turn.result.responseMessages;
    // Foi PEDIDA (e logo abaixo EXECUTADA) a correção limitada do turno mudo? O
    // valor é consumido DEPOIS dela, no desfecho terminal, junto com
    // `correcaoTruncou` (o sinal de FALHA da própria correção): correção que
    // terminou truncada (length) é defeito, mas silêncio DELIBERADO — que o
    // CORRECAO_DO_TURNO_MUDO autoriza o modelo a escolher — nunca abre caso.
    // Erro da chamada de correção propaga e o job falha na fila (retry /
    // dead-letter visível). As condições são as do próprio pedido
    // (turno-mudo.ts): razões legítimas de silêncio nem chegam a corrigir.
    let correcaoTruncou = false;
    const correcaoDoTurnoMudoPedida =
      !preview &&
      liveJob().kind === 'inbound_turn' &&
      turnoMudoPedeCorrecao({
        tentativasDeEnvio: estado.tentativasDeEnvio,
        enviadas: estado.outcomes.length,
        turnoDescartado: estado.turnoDescartado,
        passouParaAEquipe: estado.passouParaAEquipe,
        capDeEnvio: capDeEnvioAtingido(),
      });
    if (correcaoDoTurnoMudoPedida) {
      runLog.warn('turno terminou sem mensagem ao cliente — pedindo UMA correção', {
        job_id: liveJob().id,
      });
      const pedidoDeCorrecao: ModelMessage = { role: 'user', content: CORRECAO_DO_TURNO_MUDO };
      const correcao = await runModelCall(
        pool,
        deps.llmCfg,
        {
          tenantId,
          leadId: leadId || null,
          jobId: job?.id,
          agentId: agentConfig?.agentId ?? null,
          purpose: 'agent_turn',
          system,
          messages: [...openingMessages, ...turn.result.responseMessages, pedidoDeCorrecao],
          tools,
          maxSteps: Math.min(maxSteps, 3),
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
      // Sinal de FALHA da correção: terminou no teto de tokens. Silêncio com
      // finishReason normal (stop/tool-calls) é resposta escolhida, não defeito.
      correcaoTruncou = correcao.result.finishReason === 'length';
      mensagensDoTurno = [...mensagensDoTurno, pedidoDeCorrecao, ...correcao.result.responseMessages];
      if (estado.runError !== null) throw estado.runError;
      if (estado.outcomes.some((o) => o.kind === 'failed')) {
        throw new Error('envio marcado como failed pelo CRM — run re-tentado pela fila');
      }
      runLog.info('correção do turno mudo concluída', { messages_sent: estado.outcomes.length });
    }

    // FALHA TERMINAL VISÍVEL — só com sinal de FALHA, nunca por silêncio
    // deliberado (#2938): o CORRECAO_DO_TURNO_MUDO autoriza o modelo a responder
    // "nada a dizer", então silêncio que persiste com a correção NÃO é defeito.
    // Duas causas, um único bloco (um caso humano por turno, nunca duplicado):
    //  - saída TRUNCADA (finish_reason=length): o modelo cortou no teto de tokens;
    //  - a correção limitada do turno mudo (UMA, `correcaoDoTurnoMudoPedida`
    //    acima) TAMBÉM terminou truncada (`correcaoTruncou`) — sinal de falha.
    // As condições isentam toda razão LEGÍTIMA de silêncio — turno descartado
    // (obsoleto), passagem para a equipe (handoff do cliente), teto de pacing, e
    // `tentativasDeEnvio === 0` (o modelo nunca chegou a chamar `send_message`;
    // se chamou e levou veto, o veto é a razão e já ensinou o modelo). Os flags
    // são re-avaliados DEPOIS da correção: se nela nasceu handoff/teto/descarte,
    // aquilo é a razão e não há caso. O caso humano abre só com `casesEnabled`
    // ligado (mesma régua dos fail-safes clínico e de promessa; `openCase`
    // deduplica caso aberto) — a falha em si continua visível pelo log de erro.
    // O bloco não despacha nada (só registra e abre caso) — logo nunca duplica
    // mensagem; `caso.ok` gateia o move do funil — logo nunca duplica caso
    // humano. O retry continua limitado à UMA correção.
    const silencioSemRazaoLegitima =
      !preview &&
      // Só turno que RESPONDE ao cliente: retomada (followup) cortada não é "cliente sem resposta".
      eTurnoDeResposta(liveJob()) &&
      estado.outcomes.length === 0 &&
      estado.seq === 0 &&
      estado.tentativasDeEnvio === 0 &&
      !estado.turnoDescartado &&
      !estado.passouParaAEquipe &&
      !capDeEnvioAtingido();
    if (silencioSemRazaoLegitima && (saidaTruncada || correcaoTruncou)) {
      const desfechoTerminal = saidaTruncada
        ? 'output_truncated_recovered_failed'
        : 'correction_truncated_failed';
      runLog.error(`${desfechoTerminal} — sem nenhuma mensagem entregue`, {
        job_id: job?.id ?? null,
        kind: liveJob().kind,
        finish_reason: turn.result.finishReason,
        correcao_limitada_rodou: correcaoDoTurnoMudoPedida,
        correcao_truncou: correcaoTruncou,
      });
      // Cases vêm desligados por padrão (`ai_agent_versions.cases_enabled`) — a
      // mesma régua dos fail-safes clínico e de promessa de caso. Com a feature
      // desligada a falha segue visível pelo log de erro acima; o caso para o
      // time (e o move do funil) só acontece com ela ligada e sem caso aberto.
      const haCasoAberto =
        agentConfig?.casesEnabled === true
          ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
          : false;
      if (agentConfig?.casesEnabled === true && !estado.openedCaseThisTurn && !haCasoAberto) {
        try {
          const caso = await openCase(
            pool,
            { tenantId, conversationId: input.conversationId, agentId: agentConfig?.agentId ?? null },
            {
              title: saidaTruncada
                ? 'Resposta do agente truncada — nenhuma mensagem saiu'
                : 'A correção automática da IA também falhou — nenhuma mensagem saiu',
              summary:
                'O cliente ficou sem resposta neste turno: a IA não entregou mensagem nenhuma e a ' +
                'correção automática não recuperou. Atendente precisa retomar a conversa e responder o cliente.',
              blocker: saidaTruncada
                ? 'A resposta da IA veio cortada no limite de tamanho, e mensagem cortada não é enviada ao cliente.'
                : 'O turno terminou sem mensagem para o cliente e a correção automática da IA também veio ' +
                  'cortada no limite de tamanho.',
              kind: 'problema',
              source: 'guardrail_autofallback',
              contextSnapshot: buildCaseContextSnapshot(),
            },
          );
          if (caso.ok) {
            estado.openedCaseThisTurn = true;
            moverParaHandoffBestEffort(desfechoTerminal);
          } else {
            // Caso não abriu (já existe um aberto) — a falha fica visível pelo log
            // de erro acima; nada de retry extra aqui.
            runLog.error(`${desfechoTerminal} — caso humano não abriu (já existe)`, {
              job_id: job?.id ?? null,
              code: caso.error.code,
            });
          }
        } catch (err) {
          // Best-effort: erro do banco não pode mascarar a causa original.
          runLog.error(`${desfechoTerminal} — openCase lançou`, {
            job_id: job?.id ?? null,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
          });
        }
      }
    }

    // ROTEIRO: a pergunta pendente é compromisso. Se o modelo não a fez, o motor
    // a manda — pela MESMA cadeia de guardrails, dentro do teto de envios. Roda
    // mesmo com o teto cheio: registrar que o MODELO fez a pergunta é o que a
    // torna "a pergunta atual" no turno seguinte.
    if (roteiro !== null) {
      await garantirPerguntaDoRoteiro(
        { pool, log: runLog },
        {
          organizationId: tenantId,
          roteiro,
          corposEnviados: estado.corposEnviados,
          enviar: async (texto) => {
            // #1943: turno descartado como obsoleto → a pergunta do roteiro NÃO
            // sai (segue pendente para o turno seguinte). Também vigia o teto
            // de mensagens físicas do turno (F2-15b).
            if (!perguntaDoRoteiroPodeSair({ turnoDescartado: estado.turnoDescartado, seq: estado.seq, maxSendsPerTurn })) return false;
            const chain = await runBeforeSend({
              pool,
              log: runLog,
              agentOperation,
              tenantId,
              leadId,
              jobId: liveJob().id,
              channelSessionId: input.channelSessionId,
              body: texto,
              optedOutThisTurn,
              // Sai no MESMO turno da resposta: sem isto, às 3h com a janela de
              // resposta aberta, o agente responde e a pergunta do roteiro é vetada.
              resposta: eTurnoDeResposta(liveJob()),
              crmDailyLimit: null,
              // A pergunta repete por design (foi feita e não respondida); o
              // anti-blast vetaria justamente o que esta trava garante. Mesmo
              // motivo do aviso de escalação.
              enforceSpinning: false,
              now: clock(),
              sleep: deps.sleep,
              lgpd,
              ...(deps.knobs.disclosureMode !== undefined
                ? { disclosureMode: deps.knobs.disclosureMode }
                : {}),
              send: (finalBody: string) => {
                pararDigitando(); // a mensagem sai agora; renovar depois dela mentiria
                estado.seq += 1;
                return liveChannel().send({
                  tenantId,
                  leadId,
                  jobId: liveJob().id,
                  jobClaim: claimOfJob(liveJob()),
                  agentOperation,
                  seq: estado.seq,
                  conversationId: input.conversationId,
                  body: finalBody,
                });
              },
            });
            return chain.status !== 'vetoed' && (chain.outcome.kind === 'sent' || chain.outcome.kind === 'already_sent');
          },
        },
      );
    }

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
      return;
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
      return;
    }

    // Wave 3 (2.4): o checkpoint anterior é lido ANTES de gravar o novo — a
    // timeline recebe o DIFF, nunca o snapshot. Emitir a cada turno encheria a
    // tela com "a IA pensou" e enterraria a única linha que muda o que alguém
    // faria a seguir.
    const checkpointAnterior = await latestCheckpoint(pool, tenantId, leadId);
    await insertCheckpoint(pool, { tenantId, leadId, jobId: liveJob().id, content });

    // F13 — efeitos pós-turno (ADR-0006, S3): Operador, emissão, nota, golden, veto e cap.
    await executarEfeitosPosTurno(
      { deps, job, pool, ctx, input, preview, tenantId, leadId, clock, runLog, liveJob },
      {
        agentConfig, content, checkpointAnterior, closing, stageSuggestion, confirmedStage: estado.confirmedStage,
        outcomes: estado.outcomes, pacingCapVeto: estado.pacingCapVeto, inboundsPendentes, turn,
      },
    );
  } finally {
    // Turno que terminou sem enviar (veto, handoff, erro) também para de renovar.
    pararDigitando();
    await mcpCleanup?.();
  }
}

export async function runAgentPreview(
  deps: InboundTurnDeps,
  pool: pg.Pool,
  preview: TurnPreview,
): Promise<void> {
  await executarTurnoDoAgente(
    deps,
    null,
    pool,
    { workerId: '' },
    {
      channelSessionId: preview.channelId ?? '',
      conversationId: preview.context.context.conversation_id ?? '',
      buildOpening: ({
        previous,
        leadState,
        context,
        notesIndexBlock,
        projeta,
        entregues,
        compromissosBlock,
      }) =>
        buildOpeningMessage(
          previous,
          leadState,
          context,
          notesIndexBlock,
          projeta,
          entregues,
          compromissosBlock,
        ),
    },
    preview,
  );
}

/**
 * O aviso ao lead de que uma pessoa vai assumir, para as saídas da condução da
 * cadência (teto de turnos, agente indisponível). Mesmo emissor e mesmo canal
 * da escolta do orçamento; chamado ANTES da passagem.
 */
export function avisoAoLeadDoTurno(
  deps: InboundTurnDeps,
  pool: pg.Pool,
  job: JobRow,
  channelSessionId: string,
  conversationId: string,
  log: Logger,
): () => Promise<DesfechoDoAviso> {
  return () =>
    avisarLeadLendoOContato(
      pool,
      {
        tenantId: job.organization_id,
        leadId: job.contact_id ?? '',
        conversationId,
        channelSessionId,
        jobId: job.id,
      },
      {
        motivo: 'outro',
        channel: (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool),
        now: deps.clock?.() ?? new Date(),
        log,
        ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      },
    );
}

/** A abertura padrão do turno inbound (sem bloco temporal). */
const aberturaInbound: AgentTurnInput['buildOpening'] = ({
  previous,
  leadState,
  context,
  notesIndexBlock,
  projeta,
  entregues,
  compromissosBlock,
  origemBlock,
  currentInboundText,
}) =>
  buildOpeningMessage(
    previous,
    leadState,
    context,
    notesIndexBlock,
    projeta,
    entregues,
    compromissosBlock,
    currentInboundText,
    origemBlock,
  );

/**
 * As guardas do RASCUNHO (modo assistido). `true` = pode gerar.
 *
 * O GATE VALE TAMBÉM NO ASSISTIDO, e é aqui que ele precisa estar.
 *
 * O drain desliga a checagem antes de enfileirar quando a org tem agente
 * assistido publicado no canal (`canAssist`, drain.ts) — de propósito: o
 * rascunho é o produto do modo assistido, e barrar no drain o mataria. Só
 * que o ramo assistido devolve ANTES de `runAgentTurn`, onde moram as duas
 * guardas (isLeadInHandoff + decidirElegibilidadeDaConversa). Resultado
 * medido: conversa com dono humano (`assignee_kind`), com `force_human`
 * ou com o bot silenciado (`bot_silenced_until`) recebia rascunho assim
 * mesmo — o gêmeo do fluxo automático não alcança este caminho.
 *
 * Fica no ramo, não antes dele: o caminho automático já refaz as duas
 * checagens em `runAgentTurn`, e antecipá-las custaria duas queries por
 * turno sem mudar nenhum desfecho.
 */
async function podeGerarRascunho(
  deps: InboundTurnDeps,
  pool: pg.Pool,
  job: JobRow,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  if (await isLeadInHandoff(pool, job.organization_id, contactId)) {
    deps.log.info('rascunho pulado — lead em handoff humano (bot silenciado)', {
      job_id: job.id,
      conversation_id: conversationId,
    });
    return false;
  }
  try {
    const elegib = await decidirElegibilidadeDaConversa(pool, {
      organizationId: job.organization_id,
      conversationId,
      agora: new Date(),
      ttlMs: deps.knobs.allowlistTtlMs ?? ALLOWLIST_TTL_MS_PADRAO,
    });
    if (elegib !== null && !elegib.permite) {
      deps.log.info('rascunho pulado — conversa não elegível para IA', {
        job_id: job.id,
        conversation_id: conversationId,
        motivo: elegib.motivo,
      });
      return false;
    }
  } catch (err) {
    // Degrada ABERTO, igual ao gêmeo de `runAgentTurn`: falha da consulta
    // não pode calar um assistido cuja conversa está liberada. Quem barra
    // de verdade — handoff — já rodou acima e falha fechado.
    deps.log.warn('checagem de elegibilidade falhou — seguindo para o rascunho', {
      job_id: job.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
  return true;
}

/**
 * O turno de uma conversa sob CONDUÇÃO da cadência. O agente é o da condução
 * (sem roteador, sem sticky), com as ferramentas e o funil restritos ao
 * objetivo. Agente despublicado, pausado ou (no automático) passado a
 * assistido: a condução acaba e uma pessoa assume — nunca o agente genérico.
 */
async function turnoDaConducao(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  payload: z.infer<typeof inboundTurnPayloadSchema>,
  contactId: string,
  conducao: ConducaoViva,
): Promise<void> {
  const log = withFields(deps.log, { job_id: job.id, conducao_id: conducao.id });
  if (await isLeadInHandoff(pool, job.organization_id, contactId)) {
    log.info('turno da condução pulado — lead em handoff humano');
    return;
  }
  const cfg = await loadPublishedAgentConfigById(pool, job.organization_id, conducao.agent_id);
  if (
    cfg === null ||
    cfg.pausedAt ||
    (conducao.modo === 'automatico' && cfg.operationMode === 'assisted')
  ) {
    await encerrarConducaoEPassarParaHumano(
      pool,
      conducao,
      'agente_indisponivel',
      log,
      avisoAoLeadDoTurno(deps, pool, job, payload.channel_session_id, payload.conversation_id, log),
    );
    return;
  }
  const config = restringirConfigAConducao(cfg, conducao);
  const resolvedAgent: TurnAgentResolution = {
    config,
    routerId: null,
    intentName: null,
    confidence: null,
    outcome: 'conducao',
  };

  if (conducao.modo === 'assistido') {
    if (!(await podeGerarRascunho(deps, pool, job, contactId, payload.conversation_id))) return;
    // #1648 (upstream) — as detecções DETERMINÍSTICAS (STOP/opt-out e pedido de
    // humano) rodam antes do rascunho também na condução: o pedido de parar não
    // pode depender de uma aprovação que talvez nunca venha (LGPD).
    if (
      await deteccoesDeterministicasDoAssistido(pool, deps, {
        job,
        tenantId: job.organization_id,
        conversationId: payload.conversation_id,
        channelSessionId: payload.channel_session_id,
        leadId: contactId,
        agent: config,
        log,
        inboundMessageId: payload.inbound_message_id,
      })
    ) {
      return;
    }
    // Cada rascunho gasta LLM e CONTA como turno, `failed` inclusive.
    const turnos = await contarTurno(pool, job.organization_id, conducao.id);
    if (turnos === null) return;
    if (turnos > MAX_TURNOS_POR_CONDUCAO) {
      await encerrarConducaoEPassarParaHumano(
        pool,
        conducao,
        'teto_de_turnos',
        log,
        avisoAoLeadDoTurno(deps, pool, job, payload.channel_session_id, payload.conversation_id, log),
      );
      return;
    }
    const { generateReplyDraft } = await import('./reply-drafts');
    const rascunho = await generateReplyDraft(pool, deps, {
      organizationId: job.organization_id,
      conversationId: payload.conversation_id,
      contactId,
      channelId: payload.channel_session_id,
      boundary: currentExecutionBoundary() ?? undefined,
      agent: config,
      conducao,
    });
    if (rascunho?.status === 'pending') await avisarEquipeDoRascunho(pool, conducao, log);
    return;
  }

  await runAgentTurn(deps, job, pool, ctx, {
    resolvedAgent,
    conducao,
    channelSessionId: payload.channel_session_id,
    conversationId: payload.conversation_id,
    inboundMessageId: payload.inbound_message_id,
    buildOpening: aberturaInbound,
  });
}

/**
 * Handler de `inbound_turn` para o registry do daemon (main.ts): o lead mandou uma
 * mensagem. Ids de envio vêm do payload do drain (fonte confiável — F2-05); a
 * abertura é o ritual padrão, sem bloco temporal.
 */
export function createInboundTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const payload = inboundTurnPayloadSchema.parse(job.payload);
    if (!job.contact_id) throw new Error('reply_without_contact');
    // CONDUÇÃO DA CADÊNCIA: lida pela conversa, nunca pelo payload. Viva, ela
    // fixa o agente e o caminho; sem ela, nada muda.
    const conducao = await conducaoVivaDaConversa(pool, job.organization_id, payload.conversation_id);
    if (conducao !== null) {
      await turnoDaConducao(deps, job, pool, ctx, payload, job.contact_id, conducao);
      return;
    }
    // AS TRAVAS VÊM ANTES DE ESCOLHER O AGENTE, e é aqui que elas precisam estar.
    //
    // Escolher o agente pergunta à IA de sempre e, com a tarefa do roteador do
    // Jev rodando, manda a mensagem ao Jev — um fornecedor nos EUA, com aceite
    // próprio — e grava a observação. Com as travas depois, a conversa que
    // nenhum agente vai atender (lead em handoff, `force_human`, bot
    // silenciado, dono humano, número fora da lista de teste no pré-go-live)
    // saía mesmo assim: o drain só barra a conversa não elegível quando NÃO há
    // agente assistido (`canAssist`, drain.ts), e o operador que limitou a IA a
    // números de teste via a mensagem de cliente real ir para fora.
    //
    // O ASSISTIDO também passa por aqui: o drain desliga o gate quando a org
    // tem agente assistido publicado no canal — de propósito, o rascunho é o
    // produto do modo assistido e barrar no drain o mataria —, e o ramo
    // assistido abaixo devolve ANTES de `runAgentTurn`, onde moram as mesmas
    // duas guardas. Sem elas aqui, conversa com dono humano recebia rascunho.
    //
    // ponytail: o caminho automático refaz as duas em `runAgentTurn` (que
    // também serve follow-up e caso) — duas consultas a mais por turno, contra
    // a IA de sempre e o Jev que elas poupam numa conversa calada.
    if (await isLeadInHandoff(pool, job.organization_id, job.contact_id)) {
      deps.log.info('turno pulado — lead em handoff humano (bot silenciado)', {
        job_id: job.id,
        conversation_id: payload.conversation_id,
      });
      return;
    }
    try {
      const elegib = await decidirElegibilidadeDaConversa(pool, {
        organizationId: job.organization_id,
        conversationId: payload.conversation_id,
        agora: deps.clock?.() ?? new Date(),
        ttlMs: deps.knobs.allowlistTtlMs ?? ALLOWLIST_TTL_MS_PADRAO,
      });
      if (elegib !== null && !elegib.permite) {
        deps.log.info('turno pulado — conversa não elegível para IA', {
          job_id: job.id,
          conversation_id: payload.conversation_id,
          motivo: elegib.motivo,
        });
        return;
      }
    } catch (err) {
      // Degrada ABERTO, igual ao gêmeo de `runAgentTurn`: falha da consulta
      // não pode calar um agente cuja conversa está liberada. Quem barra de
      // verdade — handoff — já rodou acima e falha fechado.
      deps.log.warn('checagem de elegibilidade falhou — seguindo', {
        job_id: job.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
    const resolvedAgent = await resolveConversationTurn(pool, deps.llmCfg, {
      tenantId: job.organization_id,
      leadId: job.contact_id,
      jobId: job.id,
      conversationId: payload.conversation_id,
      channelSessionId: payload.channel_session_id,
      inbound: true,
    }, { log: deps.log, jev: deps.jev });
    const operationAgent = resolvedAgent.config;
    if (operationAgent?.operationMode === 'assisted') {
      // As travas do assistido (handoff e elegibilidade) já rodaram acima, antes
      // de escolher o agente.
      // #1648 — AS DETERMINÍSTICAS ANTES DO RASCUNHO. Este ramo devolvia
      // antes das detecções de STOP/opt-out e de pedido de humano: o contato
      // escrevia "SAIR" e nada era registrado, os follow-ups agendados seguiam
      // vivos e "quero falar com uma pessoa" virava só um rascunho — risco de
      // LGPD, porque o pedido de parar ficava dependendo de uma aprovação que
      // podia nunca vir. `true` = turno silenciado (aviso enviado, silêncio
      // durável, crons cancelados, item na Central) → sem rascunho algum.
      if (
        await deteccoesDeterministicasDoAssistido(pool, deps, {
          job,
          tenantId: job.organization_id,
          conversationId: payload.conversation_id,
          channelSessionId: payload.channel_session_id,
          leadId: job.contact_id,
          agent: operationAgent,
          log: deps.log,
          inboundMessageId: payload.inbound_message_id,
        })
      ) {
        return;
      }
      const { generateReplyDraft } = await import('./reply-drafts');
      if (!job.contact_id) throw new Error('reply_without_contact');
      await generateReplyDraft(pool, deps, {
        organizationId: job.organization_id,
        conversationId: payload.conversation_id,
        contactId: job.contact_id,
        channelId: payload.channel_session_id,
        boundary: currentExecutionBoundary() ?? undefined,
        agent: operationAgent,
      });
      return;
    }
    if (operationAgent?.pausedAt) return;
    // UMA RESPOSTA POR MENSAGEM: um turno que rodou antes deste pode ter lido a
    // mensagem que acordou este job e já respondido a ela — ver o cabeçalho de
    // `turno-ja-respondido.ts`, com o caso medido. A anotação vem DEPOIS da
    // pergunta e ANTES de `runAgentTurn` ler a conversa: é ela que deixa o
    // próximo turno fazer a mesma pergunta a respeito deste.
    const alvo = {
      organizationId: job.organization_id,
      contactId: job.contact_id,
      conversationId: payload.conversation_id,
      jobId: job.id,
    };
    if (await ultimaInboundJaRespondida(pool, alvo)) {
      deps.log.info('turno pulado — outro turno já viu e respondeu a última mensagem do cliente', {
        job_id: job.id,
        conversation_id: payload.conversation_id,
        inbound_message_id: payload.inbound_message_id,
      });
      return;
    }
    await anotarUltimaInboundVista(pool, alvo);
    await runAgentTurn(deps, job, pool, ctx, {
      resolvedAgent,
      channelSessionId: payload.channel_session_id,
      conversationId: payload.conversation_id,
      inboundMessageId: payload.inbound_message_id,
      buildOpening: aberturaInbound,
    });
  };
}
