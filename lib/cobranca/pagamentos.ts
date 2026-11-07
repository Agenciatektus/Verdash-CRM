/**
 * O HISTÓRICO DE PAGAMENTOS (`cobranca_pagamentos`, migration 9230).
 *
 * Fonte: a RELEITURA do provedor em `sincronizar` (nunca o corpo do webhook).
 * Upsert por (provedor, pagamento_ref): reler N vezes dá a mesma linha. As duas
 * escritas aqui são melhor esforço: falhar registra e segue, porque o histórico
 * nunca pode derrubar a sincronização da assinatura nem o estorno já feito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdaptadorDeCobranca, PagamentoLido } from "@/lib/cobranca/provedores/contrato";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { logger } from "@/lib/logger";

export type StatusDoPagamento = "pago" | "estornado_parcial" | "estornado" | "contestado";

/** Disputa vence tudo; estorno total ou parcial pelo valor; senão pago. */
export function statusDoPagamento(valorCents: number, estornadoCents: number, contestado: boolean): StatusDoPagamento {
  if (contestado) return "contestado";
  if (estornadoCents <= 0) return "pago";
  return estornadoCents >= valorCents ? "estornado" : "estornado_parcial";
}

export function linhaDoPagamento(orgId: string, provedor: ProvedorDeCobranca, p: PagamentoLido) {
  return {
    organization_id: orgId,
    provedor,
    pagamento_ref: p.pagamentoRef,
    cobranca_ref: p.cobrancaRef,
    valor_cents: p.valorCents,
    moeda: p.moeda,
    status: statusDoPagamento(p.valorCents, p.estornadoCents, p.contestado),
    // A CHECK do banco: estornado nunca passa do pago (cobrança maior que a fatura).
    valor_estornado_cents: Math.min(p.estornadoCents, p.valorCents),
    pago_em: p.pagoEm.toISOString(),
    estornado_em: p.estornadoEm?.toISOString() ?? null,
    plano_id: p.planoId,
    url_do_recibo: p.urlDoRecibo,
  };
}

/** Relê e grava. Nunca lança: devolve quantas linhas mandou, ou null se não gravou. */
export async function gravarPagamentos(
  admin: SupabaseClient,
  orgId: string,
  provedor: ProvedorDeCobranca,
  adaptador: AdaptadorDeCobranca,
  clienteRef: string,
): Promise<number | null> {
  if (!adaptador.listarPagamentos) return 0;
  try {
    const lidos = await adaptador.listarPagamentos({ clienteRef });
    if (lidos.length === 0) return 0;
    const comCobranca = lidos.filter((p) => p.cobrancaRef !== null).map((p) => linhaDoPagamento(orgId, provedor, p));
    // Sem a cobrança (fora da janela lida, pago fora do provedor) não há como saber
    // de estorno ou disputa: esses campos ficam de fora para não apagar o que já
    // foi gravado. Linha nova nasce com os defaults (`pago`, 0, sem cobrança).
    // Dois upserts: no PostgREST um lote com chaves diferentes mandaria null nas que faltam.
    const semCobranca = lidos
      .filter((p) => p.cobrancaRef === null)
      .map((p) => {
        const { status: _s, valor_estornado_cents: _v, estornado_em: _e, cobranca_ref: _c, ...resto } = linhaDoPagamento(orgId, provedor, p);
        return resto;
      });
    for (const lote of [comCobranca, semCobranca]) {
      if (lote.length === 0) continue;
      const { error } = await admin.from("cobranca_pagamentos").upsert(lote, { onConflict: "provedor,pagamento_ref" });
      if (error) throw new Error(`gravacao (${error.code ?? "sem_codigo"})`);
    }
    return lidos.length;
  } catch (e) {
    logger.warn("cobranca.pagamentos_nao_gravados", {
      organization_id: orgId,
      codigo: e instanceof Error ? e.message.slice(0, 80) : "falha_interna",
    });
    return null;
  }
}

/**
 * Depois do estorno do admin: a linha da cobrança passa a refletir o que voltou.
 * Sem linha (histórico ainda não relido), nada muda; o `charge.refunded` relê.
 * Nunca lança: o dinheiro já voltou no provedor.
 */
export async function marcarEstorno(
  admin: SupabaseClient,
  p: { orgId: string; provedor: ProvedorDeCobranca; cobrancaRef: string; valorCents: number; estornadoCents: number; agora: Date },
): Promise<boolean> {
  const { data, error } = await admin
    .from("cobranca_pagamentos")
    .update({
      status: statusDoPagamento(p.valorCents, p.estornadoCents, false),
      valor_estornado_cents: p.estornadoCents,
      estornado_em: p.agora.toISOString(),
    })
    .eq("organization_id", p.orgId)
    .eq("provedor", p.provedor)
    .eq("cobranca_ref", p.cobrancaRef)
    .neq("status", "contestado")
    .select("id");
  if (error) {
    logger.warn("cobranca.estorno_nao_marcado", { organization_id: p.orgId, codigo: error.code ?? null });
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
