"use client";
import { BarraDeFiltros, TABELA_EMPILHADA } from "@/components/pagina";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import * as React from "react";

import { Pilula, type TomDaPilula } from "@/components/ui/pilula";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CampoDeData } from "@/components/ui/campo-de-data";
import { Tray } from "@/lib/ui/icons";
import {
  useLeadCaptures,
  type DesfechoDaCaptacao,
  type LeadCaptureFilters,
  type LeadCaptureRow,
} from "@/hooks/webhooks/useLeadCaptures";
import { useWebhookSources } from "@/hooks/webhooks/useWebhookSources";
import { CapturaDetail } from "./CapturaDetail";
import { useT } from "@/hooks/i18n/useT";

const TODAS = "__todas__";

export const DESFECHO_LABEL: Record<DesfechoDaCaptacao, string> = {
  criado: "Virou lead",
  duplicado: "Reenvio",
  // `atualizado` (#2316) só aparece em fonte com a opção ligada, e é o único
  // desfecho em que o envio MUDOU o card que já existia — "Reenvio" mentiria.
  atualizado: "Card atualizado",
  recusado: "Não entrou",
};

const DESFECHO_TOM: Record<DesfechoDaCaptacao, TomDaPilula> = {
  criado: "ok",
  duplicado: "neutro",
  // O card recebeu o dado novo: é o meio-termo — deu certo, mas não é lead novo.
  atualizado: "neutro",
  recusado: "crit",
};

/**
 * Data e hora ABSOLUTAS, não "há 3 horas".
 *
 * O resto da tela de Webhooks usa tempo relativo, e ali é o certo: "último
 * recebimento há 2 min" responde "está vivo?". Aqui a pergunta é outra — a
 * pessoa está conferindo se o lead que ela viu chegar às 14h07 é o mesmo que
 * está no funil, e relativo não casa com nada que ela tenha em mãos.
 */
function quando(iso: string, idioma: string): { data: string; hora: string } {
  const d = new Date(iso);
  return {
    data: d.toLocaleDateString(idioma, { day: "2-digit", month: "2-digit", year: "2-digit" }),
    hora: d.toLocaleTimeString(idioma, { hour: "2-digit", minute: "2-digit" }),
  };
}

function identidade(row: LeadCaptureRow, t: (texto: string) => string): string {
  return row.captured_name ?? row.captured_phone ?? row.captured_email ?? t("(sem identificação)");
}

/** `datetime-local` devolve hora local sem fuso; o filtro é ISO. */
function paraIso(valor: string): string | undefined {
  if (!valor) return undefined;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function CapturasTab() {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const [busca, setBusca] = React.useState("");
  const [buscaAplicada, setBuscaAplicada] = React.useState("");
  const [fonte, setFonte] = React.useState<string>(TODAS);
  const [desfecho, setDesfecho] = React.useState<string>(TODAS);
  const [de, setDe] = React.useState("");
  const [ate, setAte] = React.useState("");
  const [aberta, setAberta] = React.useState<LeadCaptureRow | null>(null);

  // A busca vale 400ms depois da última tecla (a barra da página não tem botão "Buscar").
  React.useEffect(() => {
    const id = setTimeout(() => setBuscaAplicada(busca.trim()), 400);
    return () => clearTimeout(id);
  }, [busca]);

  const { data: fontesRes } = useWebhookSources();
  const fontes = fontesRes?.data ?? [];

  const filtros: LeadCaptureFilters = React.useMemo(
    () => ({
      ...(fonte !== TODAS ? { source_id: fonte } : {}),
      ...(desfecho !== TODAS ? { outcome: desfecho as DesfechoDaCaptacao } : {}),
      ...(buscaAplicada ? { q: buscaAplicada } : {}),
      ...(paraIso(de) ? { from: paraIso(de) } : {}),
      ...(paraIso(ate) ? { to: paraIso(ate) } : {}),
    }),
    [fonte, desfecho, buscaAplicada, de, ate],
  );

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useLeadCaptures(filtros);
  const linhas = data?.pages.flatMap((p) => p.data) ?? [];
  const temFiltro = Object.keys(filtros).length > 0;

  return (
    <div className="space-y-4 pt-4">
      <BarraDeFiltros
        busca={{ valor: busca, aoMudar: setBusca, placeholder: t("Nome, telefone ou e-mail") }}
        ativos={[fonte !== TODAS, desfecho !== TODAS, !!de, !!ate].filter(Boolean).length}
        aoLimpar={() => {
          setBusca("");
          setFonte(TODAS);
          setDesfecho(TODAS);
          setDe("");
          setAte("");
        }}
      >
        <Select value={fonte} onValueChange={setFonte}>
          <SelectTrigger aria-label={t("Filtrar por fonte")} className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS}>{t("Todas as fontes")}</SelectItem>
            {fontes.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={desfecho} onValueChange={setDesfecho}>
          <SelectTrigger aria-label={t("Filtrar por resultado")} className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS}>{t("Todos")}</SelectItem>
            <SelectItem value="criado">{t(DESFECHO_LABEL.criado)}</SelectItem>
            <SelectItem value="duplicado">{t(DESFECHO_LABEL.duplicado)}</SelectItem>
            <SelectItem value="atualizado">{t(DESFECHO_LABEL.atualizado)}</SelectItem>
            <SelectItem value="recusado">{t(DESFECHO_LABEL.recusado)}</SelectItem>
          </SelectContent>
        </Select>
        <CampoDeData tipo="datetime-local" id="captura-de" aria-label={t("De")} value={de} onValorChange={setDe} />
        <CampoDeData tipo="datetime-local" id="captura-ate" aria-label={t("Até")} value={ate} onValorChange={setAte} />
      </BarraDeFiltros>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : isError ? (
        // ERRO NÃO É LISTA VAZIA. A versão anterior mostrava "Ninguém preencheu
        // seus formulários ainda" quando a CONSULTA falhou — a frase mais
        // tranquilizadora possível para o estado em que a pessoa mais precisa
        // saber que algo quebrou. Ela iria conferir a landing page em vez de
        // recarregar a tela.
        <div className="pt-4">
          <Card>
            <CardContent className="space-y-3 pt-6 text-center">
              <p className="text-sm text-text">{t("Não foi possível carregar o histórico.")}</p>
              <p className="text-xs text-muted-foreground">
                {t("Isto é uma falha ao consultar — não quer dizer que ninguém preencheu.")}
              </p>
              <Button type="button" variant="secondary" onClick={() => refetch()}>
                {t("Tentar de novo")}
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : linhas.length === 0 ? (
        <div className="pt-4">
          <Card>
            <CardContent className="space-y-3 pt-6 text-center">
              <Tray className="mx-auto h-10 w-10 text-accent" />
              <p className="text-sm text-muted-foreground">
                {temFiltro
                  ? t("Nenhuma captação com esses filtros. Tente ampliar o período.")
                  : t(
                      "Ninguém preencheu seus formulários ainda. Assim que o primeiro envio chegar, ele aparece aqui — com os dados, o horário e a origem.",
                    )}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          {/* A tabela rola dentro do próprio container: o corpo da página nunca
              rola na horizontal (regra de responsividade do design system). */}
          <Card className="overflow-x-auto">
            <Table className={TABELA_EMPILHADA}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Quem")}</TableHead>
                  <TableHead>{t("Contato")}</TableHead>
                  <TableHead>{t("Fonte")}</TableHead>
                  <TableHead>{t("Quando")}</TableHead>
                  <TableHead>{t("Origem")}</TableHead>
                  <TableHead>{t("Resultado")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linhas.map((row) => {
                  const w = quando(row.received_at, tagDoIdioma);
                  return (
                    // A linha continua sendo `row` para quem usa leitor de tela:
                    // um `role="button"` na <tr> a TIRA da tabela, e o leitor
                    // deixa de anunciar "linha 3 de 12" e o cabeçalho de cada
                    // célula — que é justamente o que torna uma tabela legível
                    // sem enxergar. Quem carrega o papel de botão é a primeira
                    // célula, que também é o alvo de teclado.
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => setAberta(row)}>
                      <TableCell className="max-w-[220px] truncate font-medium">
                        <button
                          type="button"
                          className="text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAberta(row);
                          }}
                        >
                          {identidade(row, t)}
                        </button>
                      </TableCell>
                      <TableCell data-rotulo={t("Contato")} className="text-sm text-muted-foreground">
                        {row.captured_phone ?? row.captured_email ?? "—"}
                      </TableCell>
                      <TableCell data-rotulo={t("Fonte")} className="max-w-[160px] truncate text-sm text-muted-foreground">
                        {row.source_name}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {w.data} <span className="tabular-nums">{w.hora}</span>
                      </TableCell>
                      <TableCell data-rotulo={t("Origem")} className="max-w-[200px] truncate text-sm text-muted-foreground">
                        {row.origin ?? row.remote_ip ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Pilula tom={DESFECHO_TOM[row.outcome]}>
                          {t(DESFECHO_LABEL[row.outcome])}
                        </Pilula>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          {hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="secondary"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <CapturaDetail captura={aberta} onOpenChange={(o) => !o && setAberta(null)} />
    </div>
  );
}
