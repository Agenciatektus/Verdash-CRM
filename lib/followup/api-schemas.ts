/**
 * Zod "shape" schemas for the follow-up flows REST API (Task 3.1).
 * Structural graph validation (min nodes, node/edge shape) lives in
 * `graph-schema.ts`; publish-time semantic checks (reachability, coverage)
 * live in `validate-publish.ts`. This file only covers request bodies.
 */
import { z } from "zod";
import { flowGraphSchema } from "./graph-schema";
import { MAX_THRESHOLD_MINUTES, MIN_THRESHOLD_MINUTES } from "./gap-de-retorno";
import { BASES_DA_PAUSA, MAX_PAUSA_DE_REENTRADA_MINUTES } from "./pausa-de-reentrada";

/**
 * Vocabulário da coluna `surface` (0167; `atendimento` na 0394 — roteiro de
 * perguntas conduzido no turno, módulo opcional `fluxos_atendimento`; `cadence`
 * na 9016, do fork — a cadência de prospecção do funil; `campaign` na 9037, do
 * fork — os passos de uma campanha, do 2º toque em diante). O CHECK do banco
 * espelha esta tupla (forward-fix 9023 refaz a união depois da 0394).
 *
 * ⚠️ `cadence` e `campaign` NÃO se criam por esta API. A campanha tem porta
 * própria (a tela dela); a cadência tinha a rota `/api/v1/cadencias`, removida
 * com a feature, e por isso hoje NINGUÉM cria `cadence`. Dos 6 pointers
 * legados que sobraram, NENHUMA porta desta API alcança mais: criar, editar,
 * publicar, parar e voltar versão recusam prospecção com 422, e a listagem já
 * os excluía. Elas estão na tupla porque o CHECK do banco a espelha, e o invariante
 * `vocabulario-banco-x-typescript` reprova divergência — não porque o editor
 * genérico as aceite. Quem decide "isto é régua de prospecção?" é
 * `lib/followup/superficies.ts`.
 */
export const FOLLOWUP_FLOW_SURFACES = [
  "followup",
  "crm_automation",
  "atendimento",
  "cadence",
  "campaign",
] as const;
export type FollowupFlowSurface = (typeof FOLLOWUP_FLOW_SURFACES)[number];

export const createFollowupFlowSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  // Superfície do fluxo (default do banco = 'followup'). A tela de Atendimento
  // cria com 'atendimento'; a de Follow-ups, sem o campo.
  surface: z.enum(FOLLOWUP_FLOW_SURFACES).optional(),
});

// `cancel_on_reply` (Task 5.2 — reatividade): se true, um enrollment `waiting_reply`
// desse fluxo cancela (outcome='replied') na 1ª resposta do contato em vez de
// acordar o classify. Sibling de `kind` (não dentro de `params`) porque é uma
// política de REAÇÃO À RESPOSTA, ortogonal a como o fluxo foi disparado — vale
// pros kinds igualmente. Default false quando ausente (fluxos existentes
// continuam acordando o classify, comportamento inalterado).
const CANCEL_ON_REPLY = { cancel_on_reply: z.boolean().optional() };

export const triggerConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({kind:z.literal("appointment_no_show"),params:z.strictObject({event_type_ids:z.array(z.string().uuid()).optional()}).optional(),...CANCEL_ON_REPLY}),
  z.strictObject({ kind: z.literal("manual"), ...CANCEL_ON_REPLY }),
  z.strictObject({ kind: z.literal("webhook"), ...CANCEL_ON_REPLY }),
  z.strictObject({
    kind: z.literal("lead_created"),
    params: z.strictObject({}).optional(),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    kind: z.literal("stage_change"),
    params: z.strictObject({ stage_id: z.string().uuid() }),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    kind: z.literal("silence"),
    params: z.strictObject({
      threshold_minutes: z.number().int().min(5).max(10_080),
      segments: z.array(z.string()).optional(),
      // Pausa antes de o fluxo recomeçar para quem já encerrou uma inscrição
      // nele (`lib/followup/pausa-de-reentrada.ts`). Ausente ou 0 = sem pausa.
      reentry_pause_minutes: z.number().int().min(0).max(MAX_PAUSA_DE_REENTRADA_MINUTES).optional(),
      // Teto do silêncio: com ele, o fluxo só começa enquanto o silêncio for
      // RECENTE (entre `threshold_minutes` e este valor). Sem ele, a varredura
      // pega todo contato calado há mais que o mínimo — horas ou dias — e um
      // fluxo de "10 minutos depois" disparava de uma vez para todos ao ser ligado.
      max_silence_minutes: z.number().int().min(5).max(10_080).optional(),
      // De onde a pausa conta (`pausa-de-reentrada.ts`). Ausente = `ultima_mensagem`.
      reentry_pause_basis: z.enum(BASES_DA_PAUSA).optional(),
      // Só alcança quem a EQUIPE já respondeu: na conversa que guarda o inbound
      // mais recente, tem de haver outbound DEPOIS dele. Ausente ou `false` = o
      // comportamento de sempre, byte a byte — ver a seção "Dívida da equipe não
      // é silêncio do cliente" no cabeçalho de `silence-sweep.ts`.
      exige_resposta_da_equipe: z.boolean().optional(),
      /**
       * Quantas vezes NO TOTAL este fluxo pode recomeçar para o mesmo contato.
       * Ausente = sem teto (o comportamento de sempre).
       *
       * A pausa de reentrada só ESPAÇA as repetições; quem nunca responde
       * continua elegível para sempre, porque nada atualiza a última mensagem
       * dele. Sem teto, o fluxo recomeça a cada pausa — 24 h, 48 h, 72 h —
       * indefinidamente.
       */
      max_enrollments_por_contato: z.number().int().min(1).max(50).optional(),
    }),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    kind: z.literal("inbound_after_silence"),
    params: z.strictObject({
      // Piso 1h / teto 90 dias: `lib/followup/gap-de-retorno.ts`. A tela pede
      // valor + unidade; o fio guarda só minutos.
      threshold_minutes: z.number().int().min(MIN_THRESHOLD_MINUTES).max(MAX_THRESHOLD_MINUTES),
      segments: z.array(z.string()).optional(),
    }),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    kind: z.literal("case_opened"),
    // ⚠️ `optional`, e não ausente. Um cliente que mande `params: {}` — o
    // formato dos outros kinds — tem de PARSEAR: `strictObject` sem a chave
    // reprovaria esse jsonb, o pointer ficaria `active` sem armar nada, e a
    // falha seria muda. Sem params porque não há o que casar: todo caso aberto
    // da organização dispara todo fluxo armado por caso.
    params: z.strictObject({}).optional(),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    kind: z.literal("conversation_end"),
    params: z.strictObject({}),
    ...CANCEL_ON_REPLY,
  }),
  // ── Gatilhos SÓ DE CADÊNCIA (ver `lib/cadencia/gatilho.ts`). Um fluxo comum que
  // os usasse passaria no schema e nunca inscreveria ninguém: a publicação dele
  // os recusa (`app/api/v1/ai/followup-flows/[id]/publish/route.ts`).
  z.strictObject({
    kind: z.literal("tag_added"),
    params: z.strictObject({ tag: z.string().trim().min(1).max(60) }),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    /** O cliente escreveu e ninguém do time respondeu há N minutos. */
    kind: z.literal("agent_sla"),
    params: z.strictObject({ threshold_minutes: z.number().int().min(5).max(10_080) }),
    ...CANCEL_ON_REPLY,
  }),
  z.strictObject({
    /** Mandamos a última mensagem e o lead não responde há N minutos. */
    kind: z.literal("lead_idle"),
    params: z.strictObject({ threshold_minutes: z.number().int().min(60).max(43_200) }),
    ...CANCEL_ON_REPLY,
  }),
]);

/** Os gatilhos que só a cadência implementa — fluxo comum não os publica. */
export const GATILHOS_SO_DE_CADENCIA = ["tag_added", "agent_sla", "lead_idle"] as const;
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

/**
 * Instalar um modelo pronto (`lib/followup/modelos/`). O corpo é mínimo de
 * propósito: nome, textos, prazos e política de handoff vêm do MODELO, nunca do
 * cliente — quem manda o grafo é o catálogo, e um body que pudesse mandar o seu
 * seria a mesma porta do PATCH com outro nome.
 *
 * `stage_id` só é lido por modelo de gatilho de etapa (`pedeEtapa`), e é
 * conferido contra a organização ativa antes de gravar: etapa de outra org no
 * body é o anti-pattern nº 10 do CLAUDE.md.
 */
export const instalarModeloSchema = z.strictObject({
  model_id: z.string().trim().min(1).max(80),
  stage_id: z.string().uuid().optional(),
  /** Renomear na hora de instalar — duas clínicas na mesma instalação, dois nomes. */
  name: z.string().trim().min(1).max(80).optional(),
});

export const patchFollowupFlowSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  draft_graph: flowGraphSchema.optional(),
  handoff_policy: z.enum(["pause", "cancel", "allow"]).optional(),
  trigger_config: triggerConfigSchema.optional(),
});

export const rollbackFollowupFlowSchema = z.strictObject({
  version_id: z.string().uuid(),
});

export const createFollowupEnrollmentSchema = z.strictObject({
  pointer_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  // Task 8.6: agente a fixar no enrollment (persona + fila). Opcional — se
  // ausente, resolve-se do próprio pointer (agentes que o armam). Validado
  // contra a org antes de gravar.
  agent_id: z.string().uuid().optional(),
});
