/**
 * Schemas do vocabulário de etiquetas (issue #852, fatia S4; cor: #1271, S6).
 *
 * A etiqueta continua sendo `text[]` onde já está — automação, webhook
 * (`lead.tag_added`) e MCP (`*.tags_changed`) falam em string há versões, e
 * trocar por tabela com FK quebraria os três contratos. O que entra aqui é só a
 * validação do que a TELA manda para a função de banco.
 *
 * ── A cor entra neste arquivo, e não na tela ─────────────────────────────────
 *
 * A validação de forma (`#rrggbb`) precisa acontecer onde a rota pode recusar
 * antes de chamar o banco: a função de operação também valida (`cor_invalida`,
 * 22023), mas quem chega por RPC direta não passa por aqui — as duas camadas
 * existem de propósito, e a de baixo é a que vale para o dado gravado.
 */
import { z } from "zod";

import { corDeEtiquetaValida, normalizarCorDeEtiqueta } from "@/lib/tags/cor-da-etiqueta";

/**
 * O teto é o mesmo do editor de etiquetas do Inbox (`conversationTagSchema`),
 * de propósito: uma etiqueta que cabe no vocabulário mas não cabe no seletor
 * seria um nome que a tela cria e não consegue oferecer.
 */
export const TAG_MAX = 60;

/** Ações do vocabulário. Cada uma é uma operação atômica do banco. */
export const ACOES_DE_VOCABULARIO = ["renomear", "juntar", "excluir", "definir_cor"] as const;
export type AcaoDeVocabulario = (typeof ACOES_DE_VOCABULARIO)[number];

export const tagSchema = z
  .string({ error: "tag_obrigatoria" })
  .trim()
  .min(1, "tag_obrigatoria")
  .max(TAG_MAX, "tag_longa_demais");

/**
 * A cor, na forma que o banco aceita: normalizada para `#rrggbb` minúsculo.
 *
 * `#ABC`, `#aabbcc` e `aabbcc` entram e saem iguais (`#aabbcc`): a régua é a
 * mesma função que a LEITURA usa para tolerar o que já estiver gravado à mão.
 * O que não entra é lixo (`nome-verde`, `#12345`), que gravaria e voltaria para
 * a tela sem pintar nada.
 *
 * "Sem cor" é `cor: null`, não string vazia — quem limpa diz que está limpando.
 */
export const corDeEtiquetaSchema = z
  .string({ error: "cor_invalida" })
  .trim()
  .refine((valor) => corDeEtiquetaValida(valor), { error: "cor_invalida" })
  .transform((valor) => normalizarCorDeEtiqueta(valor) as string);

/**
 * `juntar` é o único caso em que a tag de origem e o destino podem coexistir com
 * grafias diferentes ("vip" + "VIP" → "VIP"): a função de banco desduplica por
 * nome canônico, então aqui só se exige que o destino exista e seja diferente.
 */
export const vocabularioDeTagsSchema = z
  .object({
    acao: z.enum(ACOES_DE_VOCABULARIO, {
      error: "acao_invalida",
    }),
    tag: tagSchema,
    destino: tagSchema.nullish(),
    cor: corDeEtiquetaSchema.nullish(),
  })
  .superRefine((valor, ctx) => {
    if (valor.acao === "definir_cor") {
      // Presente-e-nula é pedido legítimo ("tirar a cor"); AUSENTE é erro de
      // quem chamou: sem o campo não dá para distinguir "limpe" de "esqueci de
      // mandar", e a operação diria que alterou quando não alterou nada.
      if (valor.cor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cor"],
          message: "cor_obrigatoria",
        });
      }
      if (valor.destino != null) {
        // `definir_cor` não renomeia: aceitar um destino aqui faria a tela
        // prometer duas coisas e a função fazer uma.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destino"],
          message: "destino_invalido_para_acao",
        });
      }
      return;
    }
    if (valor.cor != null) {
      // Renomear/juntar/excluir não falam de cor. Ignorar em silêncio deixaria a
      // tela acreditar que mandou uma cor junto.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cor"],
        message: "cor_invalida_para_acao",
      });
      return;
    }
    if (valor.acao === "excluir") return;
    if (!valor.destino) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_obrigatorio",
      });
      return;
    }
    if (
      valor.acao === "renomear" &&
      valor.destino.toLowerCase() === valor.tag.toLowerCase()
    ) {
      // Renomear para o mesmo nome (mesmo com outra caixa) não é operação: a
      // função de banco devolveria `alterou: false` e a tela diria "nada mudou"
      // sem explicar por quê.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_igual_a_tag",
      });
    }
  });

export type VocabularioDeTagsInput = z.infer<typeof vocabularioDeTagsSchema>;

/**
 * O LOTE da tela de Tags: a mesma operação, aplicada a várias etiquetas.
 *
 * Renomear fica de fora de propósito: "renomear dez etiquetas para o mesmo
 * nome" é juntar, e a tela oferece juntar com esse nome.
 *
 * O teto (50 por chamada) é o mesmo da barra em lote do Funil
 * (`LOTE_MAXIMO` de `components/kanban/BulkActionBar.tsx`): cada etiqueta é uma
 * chamada da função de banco dentro do MESMO pedido, e um pedido sem teto
 * segura a conexão pelo tempo que o operador tiver selecionado. A tela manda em
 * blocos; "selecionar todas" com 500 etiquetas vira 10 pedidos em sequência.
 *
 * Cada item é validado pelo schema de UMA etiqueta (`vocabularioDeTagsSchema`):
 * a regra de cor/destino por ação não é reescrita aqui, e uma régua nova lá vale
 * para o lote no mesmo commit.
 */
export const LOTE_MAXIMO_DE_ETIQUETAS = 50;
export const ACOES_EM_LOTE = ["juntar", "excluir", "definir_cor"] as const;
export type AcaoEmLote = (typeof ACOES_EM_LOTE)[number];

export const loteDeVocabularioSchema = z
  .object({
    acao: z.enum(ACOES_EM_LOTE, { error: "acao_invalida" }),
    tags: z
      .array(tagSchema)
      .min(1, "tags_obrigatorias")
      .max(LOTE_MAXIMO_DE_ETIQUETAS, "lote_grande_demais"),
    destino: tagSchema.nullish(),
    cor: corDeEtiquetaSchema.nullish(),
  })
  .transform((valor) => {
    // Uma etiqueta por nome canônico, e o destino de uma junção não é origem
    // dela mesma: juntar "vip" em "vip" não é operação, e na lista selecionada
    // o destino costuma estar marcado junto.
    const destino = valor.destino?.toLowerCase();
    const vistas = new Set<string>();
    const tags = valor.tags.filter((tag) => {
      const chave = tag.toLowerCase();
      if (vistas.has(chave) || (valor.acao === "juntar" && chave === destino)) return false;
      vistas.add(chave);
      return true;
    });
    return { ...valor, tags };
  })
  .superRefine((valor, ctx) => {
    if (valor.tags.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tags"], message: "tags_obrigatorias" });
      return;
    }
    // O primeiro item basta: acao, destino e cor são os mesmos para todos, e a
    // tag de cada um já passou por `tagSchema` acima.
    const item = vocabularioDeTagsSchema.safeParse({
      acao: valor.acao,
      tag: valor.tags[0],
      destino: valor.destino,
      cor: valor.cor,
    });
    if (!item.success) {
      for (const issue of item.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
      }
    }
  });

export type LoteDeVocabularioInput = z.infer<typeof loteDeVocabularioSchema>;

/** Uma linha do vocabulário, como a função de leitura devolve. */
export type LinhaDeVocabulario = {
  tag: string;
  uso_em_contatos: number;
  uso_em_leads: number;
  uso_em_conversas: number;
  em_regras: number;
  cor: string | null;
  descricao: string | null;
  no_vocabulario: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
// DUAS CURADORIAS DE ETIQUETA, UMA TELA SÓ (decisão do Peterson, 05/10/2026)
//
// O que esta ACIMA veio do upstream na v1.41.0 (#1271, "a etiqueta ganha cor").
// O que vem ABAIXO é a curadoria que a Tektus construiu em paralelo (9005), sem
// saber que o upstream estava fazendo a mesma coisa.
//
// A decisão que este bloco dizia pendente foi tomada na 9038: a TELA que fica é a
// de Tags (`app/app/settings/tags`). Ela usa os dois mundos: a operação do
// upstream (`fn_vocabulario_de_tags_operar`) para renomear, juntar, excluir e
// cor, e as sugestões da 9005 (`fn_tags_inventario`, `criarTag`, `arquivarTag`)
// para acrescentar, promover e arquivar. A tela de Etiquetas saiu do menu e o
// endereço antigo redireciona. Os schemas continuam os dois, porque os dois
// corpos de RPC continuam existindo.
// ═══════════════════════════════════════════════════════════════════════════
import { conversationTagSchema } from "./messaging";

/**
 * Os dois vocabulários, e eles continuam dois.
 *
 * `conversations.tags` é a etiqueta do ATENDIMENTO (dúvida, troca, urgente);
 * `contacts.tags` é a etiqueta da PESSOA (vip, inadimplente). São distintos de
 * propósito — o comentário de `components/inbox/ContactTagsEditor.tsx` já dizia
 * isso — e esta tela cura os dois lado a lado sem fundi-los.
 */
export const ESCOPOS_DE_TAG = ["conversa", "contato"] as const;
export type EscopoDeTag = (typeof ESCOPOS_DE_TAG)[number];
export const escopoDeTagSchema = z.enum(ESCOPOS_DE_TAG);

/**
 * A MESMA régua do Inbox: `conversationTagSchema` faz trim + lowercase + 40.
 *
 * Reusar em vez de reescrever não é economia de linha. Uma régua própria aqui
 * deixaria a curadoria gravar `Urgente` como canônica, e o editor do Inbox (que
 * faz lowercase antes de comparar) nunca casaria a sugestão com o que o
 * atendente digita — a etiqueta apareceria na lista e não funcionaria ao ser
 * clicada. A função SQL normaliza de novo, porque RPC é alcançável por qualquer
 * pessoa logada e schema de cliente não é fronteira.
 */
export const nomeDeTagSchema = conversationTagSchema;

/** Teto de 50, o mesmo de `canonicalConversationTagsSchema`. Ver a migration. */
const LIMITE_VOCABULARIO = 50;

export const tagEmUsoSchema = z.object({
  tag: z.string(),
  n: z.coerce.number().int().nonnegative(),
});
export type TagEmUso = z.infer<typeof tagEmUsoSchema>;

/**
 * Um vocabulário como a tela precisa dele.
 *
 * `.catch([])` em cada lista pelo mesmo motivo que o schema do upstream tem:
 * uma organização que nunca gravou a chave (três das quatro desta instalação,
 * medido em 18/09) devolve `undefined`, e um campo obrigatório transformaria
 * "ainda não curei nada" em erro de tela.
 */
export const vocabularioSchema = z.object({
  canonicas: z.array(z.string()).max(LIMITE_VOCABULARIO).catch([]),
  arquivadas: z.array(z.string()).max(LIMITE_VOCABULARIO).catch([]),
  em_uso: z.array(tagEmUsoSchema).catch([]),
});
export type Vocabulario = z.infer<typeof vocabularioSchema>;

/** O corpo de `fn_tags_inventario`. */
export const inventarioDeTagsSchema = z.object({
  conversa: vocabularioSchema,
  contato: vocabularioSchema,
  /**
   * A etiqueta `cliente` está reservada nesta organização?
   *
   * A tela precisa saber ANTES de desenhar os botões: oferecer "renomear" numa
   * etiqueta que o servidor vai recusar é prometer o que não se cumpre, e o
   * operador só descobriria depois de digitar o nome novo e confirmar.
   */
  cliente_pela_agenda: z.boolean().catch(false),
});
export type InventarioDeTags = z.infer<typeof inventarioDeTagsSchema>;

/**
 * Códigos, e não frases — a tela traduz (pt-BR/es).
 *
 * Mesma decisão de `definirClientePelaAgenda`: uma frase pronta no servidor
 * chegaria em português a quem usa o produto em espanhol.
 */
export type ErroDeCuradoria =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "nome_invalido"
  | "destino_ja_existe"
  | "etiqueta_do_sistema"
  | "limite"
  | "tente_de_novo"
  | "falha";

export type RespostaDeCuradoria =
  | { ok: true; registros: number; motivo?: string }
  | { ok: false; erro: ErroDeCuradoria };

/**
 * A tradução de erro do Postgres para código de tela, num lugar só.
 *
 * Com o `switch` repetido nas cinco actions, a sexta esqueceria um caso e o
 * operador receberia "Não consegui salvar" onde o banco tinha dito exatamente
 * o que estava errado — que é a diferença entre um erro que ensina e um que
 * manda tentar de novo para sempre.
 */
export function erroDeCuradoria(code: string | undefined, message: string): ErroDeCuradoria {
  if (message.includes("tags_etiqueta_do_sistema")) return "etiqueta_do_sistema";
  if (message.includes("tags_destino_ja_existe")) return "destino_ja_existe";
  if (message.includes("tags_mfa_required")) return "mfa";
  if (message.includes("tags_limite")) return "limite";
  if (message.includes("tags_nome_invalido") || message.includes("tags_escopo_invalido")) {
    return "nome_invalido";
  }
  if (code === "42501") return "sem_permissao";
  // As três que voltam a transação inteira — nada foi gravado e tentar de novo
  // resolve. Mesma lista de `definirClientePelaAgenda`: prazo de statement do
  // papel `authenticated` (0243), deadlock escolhido pelo Postgres, e conflito
  // de serialização.
  if (code === "55P03" || code === "40P01" || code === "40001") return "tente_de_novo";
  return "falha";
}
export const tagsPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  busca: z.string().trim().max(60).default(""),
});
export const tagsPageResultSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    tag: z.string(), uso_em_contatos: z.number(), uso_em_leads: z.number(),
    uso_em_conversas: z.number(), em_regras: z.number(),
    cor: z.string().nullable(), descricao: z.string().nullable(), no_vocabulario: z.boolean(),
  })),
});
