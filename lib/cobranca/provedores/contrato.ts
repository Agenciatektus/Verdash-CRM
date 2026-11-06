/**
 * O CONTRATO DE PROVEDOR DE COBRANÇA (spec cobrança do revendedor §6).
 *
 * O provedor é INSUMO, não fonte de regra: teste grátis, régua e limites moram
 * no nosso banco. O que o provedor responde é a `Situacao`, sempre RELIDA na
 * API; o webhook só acorda a leitura (`SinalDoWebhook`). Stripe (PR 3a) e Asaas
 * (PR 3b) cabem no mesmo encaixe; Mercado Pago, depois.
 *
 * Sem SDK: cada adaptador recebe `fetch` e a chave por injeção, lida a cada
 * uso. Toda falha de transporte, de HTTP ou de forma da resposta sai do
 * adaptador como `ErroDoProvedor` — nunca `TypeError`, `ZodError` ou o corpo do
 * provedor —, porque é a classe dele que decide o `ultimo_erro` da assinatura e
 * o 503/502 das rotas, e porque URL, cabeçalho e corpo vão parar em log e Sentry.
 */
import {
  PROVEDORES_DE_COBRANCA,
  type ErroDeLeitura,
  type Intervalo,
  type Modo,
  type ProvedorDeCobranca,
} from "@/lib/cobranca/vocabulario";

export { PROVEDORES_DE_COBRANCA };
export type { Modo, ProvedorDeCobranca };

export interface PlanoParaProvedor {
  readonly id: string;
  readonly nome: string;
  readonly precoCents: number;
  /** Moeda sempre BRL (CHECK de `cobranca_planos.moeda`). */
  readonly intervalo: Intervalo;
}

/** O que o webhook AUTORIZA: acordar a leitura. Nunca é fonte de estado. */
export interface SinalDoWebhook {
  readonly eventoId: string;
  readonly tipo: string;
  readonly clienteRef: string | null;
  /** Só quando o objeto não traz o cliente (Stripe Dispute): a cobrança contestada. */
  readonly cobrancaRef?: string | null;
}

/** A única verdade que o provedor nos dá — relida na API. Tradução: `lib/cobranca/estado.ts`. */
export interface Situacao {
  /** Principal: a mais recente NÃO terminal; senão a mais recente. */
  readonly assinaturaRef: string | null;
  /** Principal não terminal E com o 1º pagamento confirmado. */
  readonly existe: boolean;
  /** Não terminais, inclusive as à espera do 1º pagamento (>1 = cobrança dupla). */
  readonly assinaturasVivas: number;
  /** Nenhuma não terminal e a mais recente é terminal. */
  readonly cancelada: boolean;
  readonly cancelaNoFim: boolean;
  /** O provedor diz que a principal está devendo. */
  readonly emAtraso: boolean;
  /** Só quando o provedor sabe a data (Asaas); Stripe: null. */
  readonly vencidaDesde: Date | null;
  /** Fim do período pago. */
  readonly proximoVencimento: Date | null;
  /** Início do período efetivamente pago, usado para calcular um upgrade proporcional. */
  readonly periodoPagoDesde?: Date | null;
  /** Houve pagamento confirmado (> 0) em qualquer assinatura do cliente. */
  readonly jaPagou: boolean;
  /** Principal em teste no provedor (Stripe `trialing`): fim do teste lá. Asaas: sempre null. */
  readonly emTesteNoProvedorAte: Date | null;
  /** Pagou fatura de assinatura já terminal. */
  readonly pagamentoSemAssinaturaViva: boolean;
  /** Só de cobrança da principal NÃO terminal. */
  readonly linkDePagamento: string | null;
  /**
   * Preço da assinatura principal NO PROVEDOR, em centavos (`Situacao` é o que
   * a sincronização confere contra `cobranca_planos.preco_cents`, issue #2609).
   * `null` = não há assinatura, ou o provedor não diz o valor — aí não há o que
   * conferir.
   */
  readonly precoCents: number | null;
  /** Diagnóstico: vai para o audit `cobranca.estado_mudou`. */
  readonly statusBruto: string;
}

/** Só status HTTP e código do provedor. Nunca URL, header ou corpo (vão para log/Sentry). */
export class ErroDoProvedor extends Error {
  override readonly name = "ErroDoProvedor";

  constructor(
    readonly status: number | null,
    readonly codigo: string,
    readonly transitorio: boolean,
    readonly credencialInvalida = false,
  ) {
    super(`provedor ${status ?? "sem_resposta"} ${codigo}`);
  }
}

/**
 * O `ultimo_erro` que uma leitura falha grava na assinatura. O estado fica
 * intacto em todos os casos. Chave que não serve → `credencial_invalida`;
 * transitório (rede, 429, 5xx) → `provedor_fora`; o resto — inclusive o cliente
 * que não existe na conta da chave nova — → `leitura_invalida`, que a Visão
 * geral mostra ao dono.
 */
export function paraErroDeLeitura(erro: unknown): ErroDeLeitura {
  if (!(erro instanceof ErroDoProvedor)) return "leitura_invalida";
  if (erro.credencialInvalida) return "credencial_invalida";
  return erro.transitorio ? "provedor_fora" : "leitura_invalida";
}

/**
 * `modoExigido` recusa a chave do OUTRO modo antes de enviá-la ao provedor:
 * chave real nunca sai só para confirmar que é real.
 */
export type ResultadoDoTesteDaChave =
  | { ok: true; modo: Modo }
  | { ok: false; motivo: "chave_invalida" | "sem_permissao" | "provedor_fora" }
  | { ok: false; motivo: "modo_divergente"; modo: Modo };

/**
 * O endpoint novo já existe no provedor; os antigos só saem em `confirmar()`,
 * que quem chama roda DEPOIS de gravar o segredo. `desfazer()` apaga o novo
 * quando a gravação falha — o antigo, com o segredo que está no banco, segue valendo.
 */
export interface WebhookPreparado {
  readonly segredo: string;
  confirmar(): Promise<void>;
  desfazer(): Promise<void>;
}

/** A compra por link de pagamento, RELIDA na API a partir do id do evento. Nada do corpo do webhook entra aqui. */
export interface CompraLida {
  readonly sessaoId: string;
  /** Modo do EVENTO/sessão (`livemode`), para comparar com o modo da chave gravada. */
  readonly modo: Modo;
  /** `mode` da sessão (`subscription`, `payment`, `setup`). */
  readonly modoDaSessao: string;
  /** `payment_status` (`paid`, `unpaid`, `no_payment_required`). */
  readonly pagamento: string;
  readonly status: string | null;
  readonly clienteRef: string | null;
  readonly assinaturaRef: string | null;
  readonly intervaloDaAssinatura: "month" | "year" | null;
  readonly email: string | null;
  readonly nome: string | null;
  readonly planoChave: string | null;
  readonly nomeDaEmpresa: string | null;
  readonly clientReferenceId: string | null;
}

/** Uma cobrança paga do cliente, com o que dela já voltou. */
export interface CobrancaEstornavel {
  readonly ref: string;
  readonly valorCents: number;
  readonly estornadoCents: number;
  readonly moeda: string;
  readonly pagaEm: Date;
}

/** Um pagamento confirmado do cliente, RELIDO na API (vai para `cobranca_pagamentos`). Sem dado de cartão. */
export interface PagamentoLido {
  /** Fatura (Stripe `in_`) ou cobrança do provedor: a chave do upsert, com o provedor. */
  readonly pagamentoRef: string;
  /** A cobrança que o estorno usa (Stripe `ch_`); null se não achada. */
  readonly cobrancaRef: string | null;
  readonly valorCents: number;
  readonly moeda: string;
  readonly estornadoCents: number;
  readonly contestado: boolean;
  readonly pagoEm: Date;
  readonly estornadoEm: Date | null;
  readonly planoId: string | null;
  readonly urlDoRecibo: string | null;
}

export interface AdaptadorDeCobranca {
  readonly id: ProvedorDeCobranca;
  testarChave(opcoes?: { modoExigido?: Modo }): Promise<ResultadoDoTesteDaChave>;
  prepararWebhook(
    url: string,
    emailDoDono: string,
  ): Promise<WebhookPreparado | { manual: { url: string; segredo: string; eventos: string[] } }>;
  /** Apaga os endpoints DESTA instalação (mesma URL ou mesma marca), menos `exceto`. Devolve quantos. */
  removerWebhooks(url: string, exceto?: string): Promise<number>;
  /**
   * O cliente existe na conta DESTA chave? 404 → false; o resto sobe como
   * `ErroDoProvedor`. É a guarda da troca de chave: chave de OUTRA conta com
   * empresas pagando pararia a leitura de todas (Stripe `GET /customers/{id}`,
   * Asaas `GET /customers/{id}`).
   */
  clienteExiste(clienteRef: string): Promise<boolean>;
  /** null = inválido. Corpo CRU. Tempo constante. Nunca lança. */
  verificarWebhook(corpoCru: string, headers: Headers, segredo: string, agora: Date): SinalDoWebhook | null;
  garantirCliente(org: { id: string; nome: string; email: string; documento: string | null }): Promise<string>;
  iniciarAssinatura(p: {
    clienteRef: string;
    orgId: string;
    plano: PlanoParaProvedor;
    trialAte: Date | null;
    urlDeVolta: string;
    chaveIdempotencia: string;
  }): Promise<{ url: string; expiraEm: Date | null; assinaturaRef: string | null; sessaoId: string | null }>;
  iniciarAjusteProporcional(p: { clienteRef: string; orgId: string; plano: PlanoParaProvedor; valorCents: number; chaveIdempotencia: string; urlDeVolta: string }): Promise<{ pagamentoRef: string; url: string }>;
  lerPagamentoProporcional(pagamentoRef: string): Promise<"pendente" | "pago" | "encerrado">;
  lerSituacao(p: { clienteRef: string }): Promise<Situacao>;
  /** Atualiza o preço recorrente sem mudar a data de renovação. Pode recusar com ErroDoProvedor não transitório. */
  trocarPlano(p: { assinaturaRef: string; plano: PlanoParaProvedor }): Promise<void>;
  /**
   * Mata NO PROVEDOR a sessão de pagamento aberta (issue #2609), para a troca de
   * plano acontecer na hora sem deixar um link vivo com o preço antigo. `sessaoId`
   * é o `sessaoId` que `iniciarAssinatura` devolveu, gravado em
   * `cobranca_assinaturas.checkout_sessao_id` — id de OUTRO provedor não expira
   * nada, e recusa (`ErroDoProvedor` não transitório) em vez de fingir sucesso.
   * Já expirada/apagada (404) é o efeito desejado: não é falha.
   */
  expirarSessao(sessaoId: string): Promise<void>;
  cancelarNoFim(assinaturaRef: string): Promise<void>;
  /** Encerra NA HORA, sem acesso até o fim do período: é o que deixa `assinaturasVivas` em zero (o dono, para excluir a empresa). Já encerrada (404) não é falha. */
  cancelarAgora(assinaturaRef: string): Promise<void>;
  /** Opcional: só o provedor que sabe estornar. A última cobrança paga do cliente, ou null se nunca pagou. */
  lerUltimaCobranca?(p: { clienteRef: string }): Promise<CobrancaEstornavel | null>;
  /** Opcional. Devolve `valorCents` da cobrança; a mesma `chaveIdempotencia` repetida não estorna duas vezes. */
  estornarCobranca?(p: { cobrancaRef: string; valorCents: number; chaveIdempotencia: string }): Promise<void>;
  /**
   * Opcional: os pagamentos confirmados do cliente, com o que deles voltou.
   * Sem o método (Asaas, por ora), a sincronização não grava histórico.
   */
  listarPagamentos?(p: { clienteRef: string }): Promise<PagamentoLido[]>;
  urlDeGerenciar(p: { clienteRef: string; urlDeVolta: string }): Promise<string | null>;
  /** Venda direta (só Stripe): evento -> sessão de checkout -> compra, tudo relido na API. */
  lerCompra?(eventoId: string): Promise<CompraLida>;
}
