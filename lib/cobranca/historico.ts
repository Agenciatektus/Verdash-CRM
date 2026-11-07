/**
 * O que o card Cobrança e o histórico de pagamentos decidem a partir das linhas
 * de `cobranca_pagamentos`. Puro: sem banco e sem relógio.
 */
import type { StatusDoPagamento } from "@/lib/cobranca/pagamentos";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";

export interface PagamentoDoHistorico {
  id: string;
  cobranca_ref: string | null;
  valor_cents: number;
  moeda: string;
  status: StatusDoPagamento;
  valor_estornado_cents: number;
  pago_em: string;
  estornado_em: string | null;
  url_do_recibo: string | null;
}

/** Chaves de `t()`; `Record` exaustivo: status novo não compila sem rótulo. */
export const ROTULO_DO_PAGAMENTO: Record<StatusDoPagamento, string> = {
  pago: "Pago",
  estornado_parcial: "Estornado em parte",
  estornado: "Estornado",
  contestado: "Contestado",
};

/** Há o que devolver: tem cobrança no provedor, não está contestado e sobra saldo. */
export function estornavel(p: PagamentoDoHistorico): boolean {
  return p.cobranca_ref !== null && p.status !== "contestado" && p.valor_estornado_cents < p.valor_cents;
}

/** A cobrança estornada mais recentemente (estorno parcial ou total), ou `null`. */
export function ultimoEstorno(pagamentos: readonly PagamentoDoHistorico[]): PagamentoDoHistorico | null {
  const comEstorno = pagamentos.filter((p) => p.valor_estornado_cents > 0);
  if (comEstorno.length === 0) return null;
  const quando = (p: PagamentoDoHistorico) => new Date(p.estornado_em ?? p.pago_em).getTime();
  return comEstorno.reduce((a, b) => (quando(b) > quando(a) ? b : a));
}

export interface AssinaturaParaAcoes {
  estado: EstadoDaAssinatura;
  provedor: string | null;
}

export interface AcoesDoCard {
  cancelada: boolean;
  podeGerarLink: boolean;
  podeCancelar: boolean;
  podeEstornar: boolean;
}

/**
 * Isenta (sem assinatura) não tem ação de provedor. Cancelada já encerrou no
 * provedor: sem novo cancelamento nem link. Estornar exige pagamento estornável;
 * histórico ainda vazio (não relido) deixa o botão, e a rota do estorno decide.
 */
export function acoesDoCard(assinatura: AssinaturaParaAcoes | null, pagamentos: readonly PagamentoDoHistorico[]): AcoesDoCard {
  if (!assinatura) return { cancelada: false, podeGerarLink: false, podeCancelar: false, podeEstornar: false };
  const cancelada = assinatura.estado === "cancelada";
  const noProvedor = assinatura.provedor !== null;
  return {
    cancelada,
    podeGerarLink: !cancelada && assinatura.estado !== "ativa",
    podeCancelar: !cancelada && noProvedor,
    podeEstornar: noProvedor && (pagamentos.length === 0 || pagamentos.some(estornavel)),
  };
}
