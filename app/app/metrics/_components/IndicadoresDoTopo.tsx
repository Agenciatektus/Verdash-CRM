"use client";

import { BarraDeProgresso } from "@/components/ui/barra-de-progresso";
import { CartaoDeIndicador } from "@/components/ui/cartao-de-indicador";
import { useT } from "@/hooks/i18n/useT";
import type { AttendantMetric } from "@/hooks/metrics/useAttendantMetrics";
import { formatarDuracao } from "@/lib/metrics/canais";
import type { EstadoDaMeta, MetaDaEmpresa } from "./MetaDoMesPanel";

/** Média da 1ª resposta ponderada pelas conversas de cada atendente; sem medida = null (nunca 0). */
function primeiraRespostaGeral(atendentes: AttendantMetric[]): number | null {
  let soma = 0;
  let peso = 0;
  for (const a of atendentes) {
    if (a.avg_first_response_seconds === null) continue;
    soma += a.avg_first_response_seconds * a.conversations_handled;
    peso += a.conversations_handled;
  }
  return peso > 0 ? soma / peso : null;
}

/** Os quatro números do topo de Desempenho (board da onda 2). */
export function IndicadoresDoTopo({
  meta,
  estadoDaMeta,
  atendentes,
}: {
  meta: MetaDaEmpresa | undefined;
  estadoDaMeta: EstadoDaMeta;
  atendentes: AttendantMetric[];
}) {
  const t = useT();
  const ganhas = atendentes.reduce((acc, a) => acc + a.won, 0);
  const perdidas = atendentes.reduce((acc, a) => acc + a.lost, 0);
  return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <CartaoDeIndicador
          rotulo={t("Meta do mês")}
          valor={meta ? `${meta.percentual}%` : "—"}
          explicacao={
            meta
              ? meta.atingida
                ? t("Meta atingida.")
                : `${t("Faltam")} ${meta.falta} ${t("para a meta")}`
              : estadoDaMeta === "carregando"
                ? undefined
                : estadoDaMeta === "erro"
                  ? t("Não consegui carregar a meta do mês")
                  : t("Nenhuma meta cadastrada para este mês.")
          }
        >
          {meta ? (
            <BarraDeProgresso
              valor={meta.percentual}
              rotulo={t("Meta do mês")}
              tom={meta.atingida ? "ok" : "marca"}
            />
          ) : null}
        </CartaoDeIndicador>
        <CartaoDeIndicador rotulo={t("Vendas ganhas")} valor={ganhas.toLocaleString("pt-BR")} explicacao={t("últimos 30 dias")} />
        <CartaoDeIndicador rotulo={t("Perdidos")} valor={perdidas.toLocaleString("pt-BR")} explicacao={t("últimos 30 dias")} />
        <CartaoDeIndicador
          rotulo={t("1ª resposta (média)")}
          valor={formatarDuracao(primeiraRespostaGeral(atendentes))}
          explicacao={t("ponderada pelas conversas de cada atendente")}
        />
      </div>
  );
}
