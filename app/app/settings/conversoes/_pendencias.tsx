import { Card } from "@/components/ui/card";
import { TABELA_EMPILHADA } from "@/components/pagina";
import { MOTIVO_LEGIVEL, type PendenciaDeEnvio } from "@/lib/conversoes/estado-da-conexao";
import { rotuloDoEvento } from "@/lib/conversoes/historico";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { formatCentsBRL } from "@/lib/money";

import { LinkDoNegocio } from "./_linkDoNegocio";
import { ReprocessarConversao } from "./_reprocessar";

/** "Conversões que não foram reportadas": a lista que responde "por que a plataforma não recebeu?". */
export function Pendencias({
  pendencias,
  enviadas,
  rotulosDeEtapa,
  idioma,
}: {
  pendencias: PendenciaDeEnvio[];
  enviadas: number;
  rotulosDeEtapa: Array<{ eventName: string; label: string }>;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <section id="pendencias" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-lg font-semibold">{t("Conversões que não foram reportadas")}</h2>
        <span className="text-sm text-muted-foreground">
          {enviadas} {t("conversões aceitas pela plataforma")}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          "Aceite da API não confirma atribuição ao anúncio. Confira os diagnósticos no gerenciador da plataforma. Depois de corrigir uma pendência, use o botão de reprocessamento.",
        )}
      </p>

      {pendencias.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {/*
            Ausência de pendência tem DUAS causas com significados opostos, e
            dizer só "tudo certo" esconderia a segunda: ou nada falhou, ou nunca
            fechou uma venda vinda de anúncio. Quem acabou de conectar precisa
            saber que a lista vazia ainda não prova que funciona.
          */}
          {t(
            "Nenhuma pendência. Ainda pode não haver vendas ou qualificações com origem em anúncio.",
          )}
        </p>
      ) : (
        <Card className="overflow-x-auto">
          {/* Sem `nowrap`: com as colunas quebrando linha a tabela cabe nos 768px do iPad; abaixo de 760px vira lista empilhada. */}
          <table className={`w-full text-sm ${TABELA_EMPILHADA}`}>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3 font-medium">{t("Negócio")}</th>
                <th className="p-3 font-medium">{t("Evento")}</th>
                <th className="p-3 font-medium">{t("Origem")}</th>
                <th className="p-3 font-medium">{t("Valor")}</th>
                <th className="p-3 font-medium">{t("O que houve")}</th>
                <th className="p-3 font-medium">{t("Quando")}</th>
                <th className="p-3 font-medium">{t("Próximo passo")}</th>
              </tr>
            </thead>
            <tbody>
              {pendencias.map((p) => (
                <tr key={`${p.leadId}:${p.evento}`} className="border-t align-top">
                  <td className="p-3">
                    <LinkDoNegocio className="underline underline-offset-2" leadId={p.leadId}>
                      {p.tituloDoLead ?? t("(sem título)")}
                    </LinkDoNegocio>
                  </td>
                  <td data-rotulo={t("Evento")} className="p-3">
                    {t(rotuloDoEvento(p.evento, rotulosDeEtapa))}
                  </td>
                  <td data-rotulo={t("Origem")} className="p-3">
                    {p.plataforma === "meta_ads"
                      ? "Meta Ads"
                      : p.plataforma === "google_ads"
                        ? "Google Ads"
                        : "—"}
                  </td>
                  <td data-rotulo={t("Valor")} className="p-3">
                    {p.valorCentavos === null ? "—" : formatCentsBRL(p.valorCentavos)}
                  </td>
                  <td data-rotulo={t("O que houve")} className="p-3">
                    <span>{t(MOTIVO_LEGIVEL[p.motivo ?? ""] ?? p.motivo ?? "—")}</span>
                    {p.detalhe && (
                      <span className="mt-1 block text-xs text-muted-foreground">{p.detalhe}</span>
                    )}
                  </td>
                  <td data-rotulo={t("Quando")} className="p-3 text-muted-foreground">
                    {new Date(p.tentadoEm).toLocaleString(idioma)}
                  </td>
                  <td className="p-3">
                    <ReprocessarConversao leadId={p.leadId} idioma={idioma} evento={p.evento} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
