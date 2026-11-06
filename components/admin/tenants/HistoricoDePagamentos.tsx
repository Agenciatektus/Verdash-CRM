"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DO_PAGAMENTO, type PagamentoDoHistorico } from "@/lib/cobranca/historico";
import type { StatusDoPagamento } from "@/lib/cobranca/pagamentos";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

const VARIANTE: Record<StatusDoPagamento, "success" | "warning" | "neutral" | "error"> = {
  pago: "success",
  estornado_parcial: "warning",
  estornado: "neutral",
  contestado: "error",
};

/** Moeda que o Intl não conhece não pode derrubar a tela: cai no número puro. */
function dinheiro(idioma: string, cents: number, moeda: string): string {
  try {
    return new Intl.NumberFormat(idioma, { style: "currency", currency: moeda.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${moeda.toUpperCase()}`;
  }
}

/** Últimos pagamentos da empresa (lidos do provedor pela sincronização). Lista, sem rolagem lateral em 390px. */
export function HistoricoDePagamentos({ pagamentos }: { pagamentos: readonly PagamentoDoHistorico[] }) {
  const t = useT();
  const idioma = useIdioma();
  const data = new Intl.DateTimeFormat(idioma, { dateStyle: "short" });
  return (
    <Card className="space-y-3 p-6" aria-labelledby="historico-de-pagamentos">
      <h2 id="historico-de-pagamentos" className="text-base font-semibold">{t("Histórico de pagamentos")}</h2>
      {pagamentos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Nenhum pagamento registrado ainda. Os pagamentos aparecem aqui depois da primeira cobrança paga no provedor.")}
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {pagamentos.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
              <span className="text-muted-foreground">{data.format(new Date(p.pago_em))}</span>
              <span className="font-medium tabular-nums">{dinheiro(idioma, p.valor_cents, p.moeda)}</span>
              <Badge variant={VARIANTE[p.status]}>{t(ROTULO_DO_PAGAMENTO[p.status])}</Badge>
              {p.valor_estornado_cents > 0 && (
                <span className="basis-full text-xs text-muted-foreground">
                  {t("Devolvido:")} {dinheiro(idioma, p.valor_estornado_cents, p.moeda)}
                  {p.estornado_em && `, ${data.format(new Date(p.estornado_em))}`}
                </span>
              )}
              {p.url_do_recibo && (
                <a className="basis-full text-xs underline" href={p.url_do_recibo} target="_blank" rel="noopener noreferrer">
                  {t("Ver recibo")}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
