"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { resumirErroDaImportacao } from "@/lib/channels/historico/resumo-do-erro";
import { Input } from "@/components/ui/input";
import { Escolha } from "@/components/ui/escolha";

interface Previa {
  conversas: number;
  mensagens: number;
  audios: number;
  imagens: number;
  desde: string;
  parcial: boolean;
}

type Escopo = "todos" | "so_crm";

interface Importacao {
  id: string;
  status: "previa" | "aguardando" | "rodando" | "erro" | "cancelada" | "concluida";
  dias?: number | null;
  escopo?: Escopo;
  origem?: "manual" | "queda";
  desde?: string | null;
  ate?: string | null;
  previa?: Previa | null;
  conversas_feitas?: number;
  mensagens_gravadas?: number;
  mensagens_existentes?: number;
  mensagens_ignoradas?: number;
  midias_baixadas?: number;
  midias_indisponiveis?: number;
  erro?: string | null;
  fonte?: string | null;
  cursor?: { semTelefone?: { n: number } } | null;
}

interface Historico {
  guardar_historico: boolean;
  importacao: Importacao | null;
  /** A recuperação aberta da queda (aguardando ou rodando), à parte da manual. */
  recuperacao_da_queda?: Importacao | null;
}

const DIAS = [30, 90, 180, 365] as const;
const PREVIA_TIMEOUT_MS = 120_000;

/** 409: outra aba (ou o cron) mudou a importação; não é o número que falhou. */
function ehConflito(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * A importação do histórico do número (#999), no cartão da conexão.
 *
 * A tela só pede e acompanha: quem anda a importação é o cron, uma rodada por
 * minuto, por isso o GET repete a cada 10 s enquanto há algo `rodando` ou
 * `aguardando` (a manual e a da queda). A prévia é lenta (dezenas de segundos)
 * e roda sem travar o resto do cartão.
 *
 * Spec 32: o escopo "Só contatos do CRM" vem ligado por padrão. A importação da
 * queda do número nasce sempre com esse escopo; a manual escolhe aqui.
 */
export function ChannelHistorico({ channelId }: { channelId: string }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const qc = useQueryClient();
  const idDoInterruptor = useId();
  const [dias, setDias] = useState<number>(30);
  const [soCrm, setSoCrm] = useState(true);
  const [contando, setContando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [izzyAberto, setIzzyAberto] = useState(false);
  const [tokenIzzy, setTokenIzzy] = useState("");
  const [erroDaPrevia, setErroDaPrevia] = useState<"conflito" | "rede" | "token" | null>(null);
  const rota = `/api/v1/channel-sessions/${channelId}/historico`;
  const frase = (tipo: "conflito" | "rede" | "token") =>
    tipo === "token"
      ? t("O Izzy recusou esse token. Confira se copiou inteiro e se ainda está ativo.")
      : tipo === "conflito"
      ? t("A importação mudou enquanto você olhava. A tela foi atualizada com o estado atual.")
      : t("Não foi possível falar com o número agora. Tente de novo em instantes.");
  const chave = ["channel-historico", channelId];

  const query = useQuery({
    queryKey: chave,
    queryFn: () => apiClient.get<{ data: Historico }>(rota),
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      const d = q.state.data?.data;
      return d?.importacao?.status === "rodando" || d?.recuperacao_da_queda ? 10_000 : false;
    },
  });

  const guardar = query.data?.data.guardar_historico;
  const imp = query.data?.data.importacao ?? null;
  const daQueda = query.data?.data.recuperacao_da_queda ?? null;

  async function acao(corpo: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiClient.post(rota, corpo, { timeoutMs: 20_000 });
    } catch (err) {
      toast.error(frase(ehConflito(err) ? "conflito" : "rede"));
    } finally {
      // Com sucesso ou não, a tela passa a mostrar o estado que o servidor tem.
      await qc.invalidateQueries({ queryKey: chave });
      setBusy(false);
    }
  }

  /** `izzy`: prévia do outro CRM, com o token colado (o servidor usa o escopo `todos`). */
  async function pedirPrevia(escopo: Escopo | "izzy") {
    const izzy = escopo === "izzy";
    setContando(true);
    setErroDaPrevia(null);
    try {
      await apiClient.post(
        rota,
        izzy ? { acao: "previa", dias, fonte: "izzy", token: tokenIzzy.trim() } : { acao: "previa", dias, escopo },
        { timeoutMs: PREVIA_TIMEOUT_MS },
      );
      if (izzy) setTokenIzzy("");
    } catch (err) {
      setErroDaPrevia(ehConflito(err) ? "conflito" : izzy && err instanceof ApiError && err.status === 422 ? "token" : "rede");
    } finally {
      await qc.invalidateQueries({ queryKey: chave });
      setContando(false);
    }
  }

  /** Mudar o interruptor refaz a prévia do número que está na tela, no escopo novo. */
  function mudarEscopo(ligado: boolean) {
    setSoCrm(ligado);
    if (imp?.status === "previa" && imp.fonte !== "izzy") void pedirPrevia(ligado ? "so_crm" : "todos");
  }

  if (query.isLoading) return null;
  if (query.isError) {
    return <p role="alert" className="text-[11px] text-destructive">{frase("rede")}</p>;
  }

  const titulo = <p className="text-xs font-medium">{t("Trazer conversas antigas para o atendimento")}</p>;

  const doIzzy = imp?.fonte === "izzy";
  const p = imp?.previa ?? null;
  const rodando = imp?.status === "rodando";
  const status = imp?.status;
  // Com a recuperação da queda aberta, a manual espera: a da queda tem a vez.
  const manualBloqueada = daQueda !== null;
  // Nova prévia: sem nada, depois de prévia (refazer), cancelada ou concluída.
  const podePedirPrevia = !rodando && status !== "erro" && !manualBloqueada;
  const numeros = p && doIzzy
    ? t("{conversas} conversas no Izzy").replace("{conversas}", String(p.conversas))
    : p
    ? t(p.parcial
        ? "Pelo menos {conversas} conversas, {mensagens} mensagens, {audios} áudios e {imagens} imagens"
        : "{conversas} conversas, {mensagens} mensagens, {audios} áudios e {imagens} imagens")
        .replace("{conversas}", String(p.conversas))
        .replace("{mensagens}", String(p.mensagens))
        .replace("{audios}", String(p.audios))
        .replace("{imagens}", String(p.imagens))
    : null;
  const formatarData = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleString(tag, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "";

  // Outro CRM (Izzy): independe de 'Guardar o histórico', que é do número do WhatsApp.
  const formDoIzzy = podePedirPrevia && (
    <div className="flex flex-col gap-1">
      <div>
        <Button size="sm" variant="ghost" disabled={contando || busy} onClick={() => setIzzyAberto((a) => !a)}>
          {t("Importar de outro CRM (Izzy)")}
        </Button>
      </div>
      {izzyAberto && (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            className="h-8 text-xs"
            placeholder="izzy_..."
            aria-label={t("Token da API do Izzy")}
            value={tokenIzzy}
            onChange={(e) => setTokenIzzy(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={contando || busy || tokenIzzy.trim().length < 8} onClick={() => void pedirPrevia("izzy")}>
            {contando ? t("Contando as conversas…") : t("Ver prévia")}
          </Button>
        </div>
      )}
    </div>
  );

  if (!guardar && !doIzzy) {
    return (
      <div className="flex flex-col gap-1">
        {titulo}
        <p className="text-[11px] text-muted-foreground">{t("Ligue 'Guardar o histórico' e conecte o número de novo")}</p>
        {formDoIzzy}
        {erroDaPrevia && <p role="alert" className="text-[11px] text-destructive">{frase(erroDaPrevia)}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {titulo}

      {daQueda && (
        <div className="flex flex-col gap-1 rounded-md border p-2">
          <p className="text-[11px] font-medium">
            {t("Recuperando as conversas da queda ({desde} a {ate})")
              .replace("{desde}", formatarData(daQueda.desde))
              .replace("{ate}", formatarData(daQueda.ate))}
          </p>
          {daQueda.status === "rodando" ? (
            <p className="text-[11px] text-muted-foreground">{t("Importando agora.")}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("Esperando sua vez na fila de importação.")}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t("A importação manual fica disponível quando a recuperação da queda terminar.")}
          </p>
        </div>
      )}

      {podePedirPrevia && (
        <div className="flex items-start gap-2">
          <Switch id={idDoInterruptor} checked={soCrm} disabled={contando || busy} onCheckedChange={mudarEscopo} />
          <div className="flex flex-col">
            <label htmlFor={idDoInterruptor} className="text-[11px] font-medium">
              {t("Só contatos do CRM")}
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t("Traz só as conversas de quem já tem ficha no CRM, sem criar fichas novas.")}
            </p>
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t("Período: últimos 30, 90, 180 ou 365 dias")}</p>

      {rodando && imp && (
        <>
          <p className="text-[11px]">
            {t("Importando: {feitas} de {conversas} conversas")
              .replace("{feitas}", String(imp.conversas_feitas ?? 0))
              .replace("{conversas}", String(p?.conversas ?? 0))}
          </p>
          <div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void acao({ acao: "cancelar", importacaoId: imp.id })}>
              {t("Cancelar")}
            </Button>
          </div>
        </>
      )}

      {status === "erro" && imp && (
        <>
          <p role="alert" className="text-[11px] text-destructive">{t("A importação parou por um erro.")}</p>
          {imp.erro && (
            <p className="text-[11px] text-muted-foreground">
              {t("Detalhe: {erro}").replace("{erro}", resumirErroDaImportacao(imp.erro))}
            </p>
          )}
          {/* Erro que se repete (o mesmo chat sempre recusado) não tem saída por
              "Tentar de novo": cancelar libera o número para uma prévia nova. */}
          <div className="flex items-center gap-2">
            {!doIzzy && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void acao({ acao: "retomar", importacaoId: imp.id })}>
                {t("Tentar de novo")}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void acao({ acao: "cancelar", importacaoId: imp.id })}>
              {t("Cancelar")}
            </Button>
          </div>
        </>
      )}

      {status === "concluida" && imp && (
        <>
          <p className="text-[11px] font-medium">{t("Importação concluída")}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("{gravadas} mensagens trazidas; {indisponiveis} áudios ou imagens não estavam mais disponíveis.")
              .replace("{gravadas}", String(imp.mensagens_gravadas ?? 0))
              .replace("{indisponiveis}", String(imp.midias_indisponiveis ?? 0))}
          </p>
          {!!imp.cursor?.semTelefone?.n && (
            <p className="text-[11px] text-muted-foreground">
              {t("{n} conversas do Instagram não foram importadas.").replace("{n}", String(imp.cursor.semTelefone.n))}
            </p>
          )}
        </>
      )}

      {status === "previa" && imp && numeros && (
        <>
          <p className="text-[11px]">{numeros}</p>
          <div>
            <Button
              size="sm"
              disabled={busy || contando || manualBloqueada}
              onClick={() => void acao({ acao: "importar", importacaoId: imp.id })}
            >
              {t("Importar")}
            </Button>
          </div>
        </>
      )}

      {(status === "previa" || status === "rodando" || status === "erro") && (
        <>
          <p className="text-[11px] text-muted-foreground">{t("Nenhuma mensagem antiga será respondida pela IA nem dispara automação.")}</p>
          <p className="text-[11px] text-muted-foreground">{t("Áudios e imagens antigos que o WhatsApp não guarda mais aparecem como indisponíveis.")}</p>
        </>
      )}

      {podePedirPrevia && (
        <div className="flex items-center gap-2">
          <Escolha
            aria-label={t("Período: últimos 30, 90, 180 ou 365 dias")}
            className="h-8 w-auto text-xs"
            value={dias}
            disabled={contando}
            onValueChange={(v) => setDias(Number(v))}
          >
            {DIAS.map((d) => (
              <option key={d} value={d}>{t("{dias} dias").replace("{dias}", String(d))}</option>
            ))}
          </Escolha>
          <Button
            size="sm"
            variant="outline"
            disabled={contando || busy}
            onClick={() => void pedirPrevia(soCrm ? "so_crm" : "todos")}
          >
            {contando ? t("Contando as conversas…") : t("Ver prévia")}
          </Button>
        </div>
      )}

      {formDoIzzy}

      {erroDaPrevia && (
        <p role="alert" className="text-[11px] text-destructive">{frase(erroDaPrevia)}</p>
      )}
    </div>
  );
}
