/**
 * O que a API aceita de fora. Zod em todo input externo, como manda a doutrina —
 * e nada aqui aceita `organization_id`: a organização vem do `requireRole()`,
 * nunca do corpo.
 */
import { z } from "zod";

import { saidasDaCadenciaSchema } from "@/lib/cadencia/saidas";
import { spintaxValido } from "@/lib/texto/variacao";

import { filtroDeAudienciaSchema } from "./audiencia";
import { passosDaCampanhaSchema } from "./passos";
import { MAX_VARIACOES_EXTRAS, VARIANTE_TAMANHO_MAXIMO } from "./renderizador";

/**
 * As variações EXTRAS da abordagem (migration 9034). O corpo principal segue em
 * `message_body`, com o teto de 4.096 dele — a lista efetiva é
 * `[message_body, ...message_variants]`.
 *
 * O `{a|b}` é conferido AQUI, e só nas EXTRAS: o campo é novo, então nenhuma
 * campanha existente é barrada por ele. Um `message_body` legado com chave
 * desbalanceada continua podendo ser SALVO (barrá-lo deixaria o operador preso
 * num rascunho que não dá para corrigir sem apagar); quem o barra é o gate de
 * `faltaParaEnviar`, antes de qualquer envio, com o número da variação no texto
 * do erro.
 */
const variacaoDaMensagem = z
  .string()
  .trim()
  .max(VARIANTE_TAMANHO_MAXIMO)
  .refine(spintaxValido, {
    message: "O {a|b} desta variação não fecha — confira as chaves.",
  });

const variacoesDaMensagem = z.array(variacaoDaMensagem).max(MAX_VARIACOES_EXTRAS);
import { variaveisDaCampanhaSchema } from "./modelo";
import { MODOS_DA_MENSAGEM, VELOCIDADES_DA_CAMPANHA } from "./tipos";

/**
 * O ritmo próprio. Todos opcionais e anuláveis: `null` devolve a decisão ao
 * canal, que é o default de quem nunca abriu esta seção.
 *
 * As faixas são as do CHECK da migration 0375 — validação de entrada do
 * operador, não default de comportamento (os números de pacing são fonte única
 * em `lib/agent-engine/pacing/defaults.ts`).
 */
export const ritmoSchema = z.object({
  intervalo_segundos: z.number().int().min(1).max(86_400).nullable().optional(),
  janela_inicio_hora: z.number().int().min(0).max(23).nullable().optional(),
  janela_fim_hora: z.number().int().min(1).max(24).nullable().optional(),
  teto_diario: z.number().int().min(1).max(10_000).nullable().optional(),
  teto_horario: z.number().int().min(1).max(10_000).nullable().optional(),
  /**
   * Migration 0711. Ausente = a que já está (`gradual` numa campanha nova). A
   * rota confere contra o número: rápida só com modelo aprovado.
   */
  velocidade: z.enum(VELOCIDADES_DA_CAMPANHA).optional(),
  /**
   * Migration 0765. Texto em balões, um por parágrafo; ausente = o que já está
   * (`false` numa campanha nova). Modelo aprovado nunca se divide.
   */
  split_messages: z.boolean().optional(),
});

const baseDaCampanha = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  channel_session_id: z.string().uuid(),
  message_body: z.string().trim().max(4096).nullable().optional(),
  message_variants: variacoesDaMensagem.optional(),
  /**
   * Migration 0710 (#1330, fatia 4). Ausente = `text`, que é o que toda campanha
   * anterior é. A rota confere contra o número: o modo é o que o canal aceita
   * (`modoDeCampanhaDoCanal`), nunca uma escolha solta do corpo.
   */
  message_mode: z.enum(MODOS_DA_MENSAGEM).optional(),
  provider_template_name: z.string().trim().min(1).max(512).nullable().optional(),
  provider_template_language: z.string().trim().min(2).max(15).nullable().optional(),
  provider_template_variables: variaveisDaCampanhaSchema.optional(),
  base_legal: z.enum(["consent", "legitimate_interest"]),
  lia_ref: z.string().trim().max(120).nullable().optional(),
  audience_filter: filtroDeAudienciaSchema.optional(),
  /**
   * Os números EXTRAS do rodízio (migration 0377). O principal continua em
   * `channel_session_id`; estes entram junto. Vazio = campanha de um número só,
   * que é como toda campanha existente se comporta.
   */
  channel_session_ids: z.array(z.string().uuid()).max(10).optional(),
  /**
   * A RÉGUA do 2º toque em diante (migration 9037). Vazia = campanha de uma
   * mensagem só, que é o comportamento de toda campanha existente. O funil
   * passa a ser exigido quando há passos, e isso é conferido no gate de
   * `faltaParaEnviar` (preparar, iniciar, agendar e testar) — não aqui: um
   * rascunho pode ter os passos antes de o operador escolher o funil, e barrar
   * o SALVAR o prenderia num texto que não dá para corrigir sem apagar.
   */
  passos: passosDaCampanhaSchema.optional(),
  /**
   * QUANDO A RÉGUA PARA de falar com cada pessoa (migration 9046). Ausente ou
   * `null` = o padrão (negócio fechado e humano assumindo encerram; nenhuma
   * etiqueta e nenhuma etapa), que é o comportamento de toda campanha anterior
   * a ela — ver `lib/campanhas/saidas-da-campanha.ts`.
   *
   * ⚠️ Ao contrário dos `passos` e da entrada contínua, isto é cobrado AQUI, no
   * SALVAR, e não só no gate de `faltaParaEnviar`. Os outros dois ficam de fora
   * porque um rascunho incompleto é legítimo, e barrá-lo prenderia o operador
   * num texto que ele não consegue corrigir. Uma saída não tem estado
   * incompleto: ou o objeto é legível, ou o que foi gravado não descreve
   * configuração nenhuma. Recusar na entrada é o que impede o jsonb ilegível de
   * nascer pela porta do produto, e deixa o gate como a segunda tranca (para a
   * linha que já estivesse gravada, ou escrita por fora).
   */
  saidas: saidasDaCadenciaSchema.nullable().optional(),
  /**
   * O MODO DE PÚBLICO (migration 9039). Ausente ou `false` = LISTA, o snapshot
   * congelado, que é o padrão e o comportamento de toda campanha existente.
   * `true` = CONTÍNUO: quem entra na etapa de `entrada_etapa_id` é abordado.
   *
   * O que o modo contínuo EXIGE (funil, etapa, teto do dia e janela de horário)
   * não é conferido aqui, pelo MESMO motivo dos `passos` logo acima: um rascunho
   * pode ter o modo marcado antes de o operador digitar o teto, e barrar o
   * SALVAR o prenderia num rascunho que não dá para corrigir sem apagar. Quem
   * confere é `problemaNaEntradaContinua`, chamado pelas rotas de criação e
   * edição e pelo gate de `faltaParaEnviar` (preparar, iniciar, agendar, testar).
   */
  entrada_continua: z.boolean().optional(),
  entrada_etapa_id: z.string().uuid().nullable().optional(),
  /**
   * Onde o card de quem responde nasce, e quem atende (migration 0378).
   * `null` devolve a decisão ao número, que é o comportamento de sempre.
   */
  pipeline_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  agent_id: z.string().uuid().nullable().optional(),
};

export const criarCampanhaSchema = z
  .object({ ...baseDaCampanha })
  .merge(ritmoSchema)
  .refine(
    (c) => c.base_legal !== "legitimate_interest" || (c.lia_ref ?? "").trim() !== "",
    {
      message:
        "Interesse legítimo exige a referência da avaliação (LIA) — é ela que responde a quem " +
        "perguntar com base em quê recebeu a mensagem.",
      path: ["lia_ref"],
    },
  )
  .refine((c) => c.stage_id == null || c.pipeline_id != null, {
    message: "Escolha o funil antes da etapa — etapa sem funil seria um card sem coluna.",
    path: ["stage_id"],
  })
  .refine(
    (c) =>
      c.janela_inicio_hora == null ||
      c.janela_fim_hora == null ||
      c.janela_fim_hora > c.janela_inicio_hora,
    { message: "A janela precisa terminar depois de começar.", path: ["janela_fim_hora"] },
  );

/** Edição de rascunho: tudo opcional, e a mesma checagem de base legal na rota. */
export const editarCampanhaSchema = z
  .object({
    name: baseDaCampanha.name.optional(),
    description: baseDaCampanha.description,
    channel_session_id: baseDaCampanha.channel_session_id.optional(),
    message_body: baseDaCampanha.message_body,
    message_variants: baseDaCampanha.message_variants,
    message_mode: baseDaCampanha.message_mode,
    provider_template_name: baseDaCampanha.provider_template_name,
    provider_template_language: baseDaCampanha.provider_template_language,
    provider_template_variables: baseDaCampanha.provider_template_variables,
    base_legal: baseDaCampanha.base_legal.optional(),
    lia_ref: baseDaCampanha.lia_ref,
    // PARCIAL: a rota mescla sobre o filtro salvo e valida o resultado com o
    // `filtroDeAudienciaSchema` completo (chave ausente = preservada).
    audience_filter: z.record(z.string(), z.unknown()).optional(),
    passos: baseDaCampanha.passos,
    saidas: baseDaCampanha.saidas,
    entrada_continua: baseDaCampanha.entrada_continua,
    entrada_etapa_id: baseDaCampanha.entrada_etapa_id,
    channel_session_ids: baseDaCampanha.channel_session_ids,
    pipeline_id: baseDaCampanha.pipeline_id,
    stage_id: baseDaCampanha.stage_id,
    agent_id: baseDaCampanha.agent_id,
  })
  .merge(ritmoSchema);

export const previaSchema = z.object({
  audience_filter: filtroDeAudienciaSchema,
  message_body: z.string().max(4096).default(""),
  /** As variações EXTRAS que a tela está editando — a prévia conta com elas. */
  message_variants: z.array(z.string().max(VARIANTE_TAMANHO_MAXIMO)).max(MAX_VARIACOES_EXTRAS).default([]),
  campaign_id: z.string().uuid().optional(),
  /**
   * Com modelo, quem sai por `variavel_ausente` é decidido pelo MAPA de
   * variáveis, não pelo texto — a prévia precisa dele para contar certo.
   */
  modelo: z
    .object({
      channel_session_id: z.string().uuid(),
      name: z.string().trim().min(1).max(512),
      language: z.string().trim().min(2).max(15),
      variables: variaveisDaCampanhaSchema.default({}),
    })
    .optional(),
});

export const criarTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4096),
});

export const editarTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(4096).optional(),
});

/**
 * O telefone entra CRU e sai em hash — a normalização e o hash moram em
 * `lib/campanhas/exclusoes.ts`, para o mesmo cálculo valer na gravação e na
 * consulta. Aqui só se exige que algo tenha sido digitado.
 */
export const criarExclusaoSchema = z.object({
  address: z.string().trim().min(8).max(32),
  reason: z.string().trim().max(240).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
});

/**
 * O CORPO QUE A TELA MANDA — `z.input`, e não `z.infer`.
 *
 * ═══ Por que estes dois tipos existem (parecer do @Cassio_SecRev, P1.1) ═══
 *
 * Os hooks de mutação tipavam o corpo como `Record<string, unknown>`. Com isso, a
 * primeira das trancas da régua — o Zod da rota — era a única que podia falhar em
 * SILÊNCIO: renomear a chave no payload, ou um refactor que tirasse `saidas`
 * daqui (ela só entra por `...baseDaCampanha`, nunca nominalmente), passava pelo
 * TypeScript, passava pelo Zod (que ignora campo desconhecido), gravava `null` e
 * respondia **200**. O operador via a seção preenchida, clicava Salvar, não lia
 * erro nenhum, e a campanha rodava no padrão. É o padrão que já custou caro:
 * "schema aceita campo que ninguém grava: 200, desfaz o clique, sem erro".
 *
 * Com o corpo tipado pelo schema, chave errada e campo removido viram erro de
 * COMPILAÇÃO — e isso vale de uma vez para `passos`, `entrada_continua` e
 * qualquer campo futuro, não só para `saidas`.
 *
 * `z.input`, e não `z.infer`/`z.output`: o que a tela manda é a ENTRADA do
 * schema, onde o que tem `.default()` é opcional. `z.output` cobraria da tela os
 * campos que o próprio Zod preenche, e o tipo ficaria mais estrito que a API.
 */
export type CorpoDeCriarCampanha = z.input<typeof criarCampanhaSchema>;
export type CorpoDeEditarCampanha = z.input<typeof editarCampanhaSchema>;

export const agendarSchema = z.object({ scheduled_at: z.string().datetime() });
export const testarSchema = z.object({ contact_id: z.string().uuid() });

export const listarCampanhasSchema = z.object({
  status: z.string().trim().max(20).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const listarDestinatariosSchema = z.object({
  status: z.string().trim().max(20).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Cursor opaco `created_at|id`, o mesmo formato de `lib/schemas/lead-captures.ts`.
 * Sem HMAC, como os outros: ele só ordena, não autoriza — a organização vem do
 * papel conferido, e um cursor forjado não alcança linha de outro tenant.
 */
export function codificarCursor(c: { created_at: string; id: string }): string {
  return Buffer.from(`${c.created_at}|${c.id}`, "utf8").toString("base64url");
}

export function decodificarCursor(bruto: string): { created_at: string; id: string } | null {
  try {
    const [created_at, id] = Buffer.from(bruto, "base64url").toString("utf8").split("|");
    if (!created_at || !id) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}
