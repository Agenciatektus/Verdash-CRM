import type { ReactNode } from "react";

import { Aviso } from "@/components/ui/aviso";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PendenciaDeEnvio } from "@/lib/conversoes/estado-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { Pendencias } from "./_pendencias";

type Tom = "success" | "warning" | "neutral";

/** Um destino das conversões: o estado numa pílula, duas linhas e o botão que leva à aba. */
function CartaoDoDestino({
  nome,
  tom,
  estado,
  linhas,
  aba,
  botao,
}: {
  nome: string;
  tom: Tom;
  estado: string;
  linhas: Array<[string, ReactNode]>;
  aba: string;
  botao: string;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid={`destino-${aba}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate font-semibold">{nome}</h3>
        <Badge variant={tom}>{estado}</Badge>
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        {linhas.map(([rotulo, valor]) => (
          <div key={rotulo} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{rotulo}</dt>
            <dd className="text-right font-medium">{valor}</dd>
          </div>
        ))}
      </dl>
      <Button asChild variant="outline" size="sm" className="mt-auto self-start">
        <a href={`?aba=${aba}`}>{botao}</a>
      </Button>
    </Card>
  );
}

export interface ResumoDosDestinos {
  meta: { conectada: boolean; habilitada: boolean; peloCanal: boolean };
  google: {
    conectada: boolean;
    habilitada: boolean;
    /** null = as regras não puderam ser lidas. */
    etapas: { ligadas: number; total: number } | null;
  };
  site: { capturaLigada: boolean };
}

export function AbaVisaoGeral({
  resumo,
  pendencias,
  enviadas,
  rotulosDeEtapa,
  idioma,
}: {
  resumo: ResumoDosDestinos;
  pendencias: PendenciaDeEnvio[];
  enviadas: number;
  rotulosDeEtapa: Array<{ eventName: string; label: string }>;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const ligado = (v: boolean) => (v ? t("Ligado") : t("Desligado"));
  const { meta, google, site } = resumo;
  return (
    <>
      {pendencias.length > 0 && (
        <Aviso
          tom="warn"
          acao={
            <Button asChild variant="outline" size="sm">
              <a href="#pendencias">{t("Ver pendência")}</a>
            </Button>
          }
        >
          {t("Pendências de envio:")} {pendencias.length}. {t("Veja o motivo na lista abaixo.")}
        </Aviso>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <CartaoDoDestino
          nome="Meta"
          tom={!meta.conectada ? "neutral" : meta.habilitada ? "success" : "warning"}
          estado={
            !meta.conectada ? t("Não conectada") : meta.habilitada ? t("Enviando") : t("Envio desligado")
          }
          linhas={[
            [t("Envio automático"), ligado(meta.conectada && meta.habilitada)],
            [t("Pelo canal do WhatsApp"), ligado(meta.peloCanal)],
          ]}
          aba="meta"
          botao={meta.conectada ? t("Configurar") : t("Conectar")}
        />
        <CartaoDoDestino
          nome="Google Ads"
          tom={!google.conectada ? "neutral" : google.habilitada ? "success" : "warning"}
          estado={
            !google.conectada
              ? t("Não conectada")
              : google.habilitada
                ? t("Enviando")
                : t("Envio desligado")
          }
          linhas={[
            [t("Envio automático"), ligado(google.conectada && google.habilitada)],
            [
              t("Etapas enviando"),
              google.etapas ? `${google.etapas.ligadas} ${t("de")} ${google.etapas.total}` : "—",
            ],
          ]}
          aba="google"
          botao={google.conectada ? t("Configurar") : t("Conectar")}
        />
        <CartaoDoDestino
          nome={t("Site e WhatsApp")}
          tom={site.capturaLigada ? "success" : "neutral"}
          estado={site.capturaLigada ? t("Captura ligada") : t("Captura desligada")}
          linhas={[
            [t("Endereço de captura"), ligado(site.capturaLigada)],
            [t("Script no site"), site.capturaLigada ? t("Disponível") : t("Ligue uma captura")],
          ]}
          aba="site"
          botao={t("Abrir")}
        />
      </div>

      <Pendencias
        pendencias={pendencias}
        enviadas={enviadas}
        rotulosDeEtapa={rotulosDeEtapa}
        idioma={idioma}
      />
    </>
  );
}
