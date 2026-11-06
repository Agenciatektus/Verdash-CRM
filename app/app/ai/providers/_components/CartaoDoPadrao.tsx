"use client";

import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";

import type { Dados } from "./tipos";

/** O que o grupo usa hoje, sem obrigar a abrir ponto a ponto. */
export function CartaoDoPadrao({
  dados,
  aoSalvar,
  midia,
}: {
  dados: Dados;
  aoSalvar: () => Promise<void>;
  /** O interruptor da leitura de mídia (lido no servidor) mora dentro deste cartão. */
  midia?: ReactNode;
}) {
  const t = useT();
  const [provider, setProvider] = useState(dados.padrao.provider);
  const [modelId, setModelId] = useState(dados.padrao.defaultModel ?? "");
  const [salvando, setSalvando] = useState(false);

  const modelosDoProvedor = useMemo(
    () => dados.modelos.filter((m) => m.provider === provider),
    [dados.modelos, provider],
  );

  // Quantos pontos herdam HOJE. É o número que explica por que esta caixa
  // importa: numa instalação nova são 24 de 25, e trocar aqui muda os 24.
  const herdam = dados.pontos.filter((p) => p.efetivo.origem === "padrao_da_organizacao");

  // Os que o padrão NÃO resolve sozinho: embedding precisa de modelo de
  // embedding (com a dimensão certa) e áudio precisa de transcritor. Dizer
  // isto aqui é mais barato que deixar a busca degradar em silêncio depois —
  // que é o modo de falha que `avisosDeLeitura` no resolver já descreve.
  const especialistas = dados.pontos.filter(
    (p) => p.exige.embeddingDims !== undefined || p.exige.audio === true,
  );

  const mudou = provider !== dados.padrao.provider || modelId !== (dados.padrao.defaultModel ?? "");

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ai/providers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, default_model: modelId }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      // Sem catálogo sincronizado a rota grava, mas avisa que não deu para
      // conferir o identificador. Engolir o aviso trocaria um "não salvou" por um
      // "salvou" que só falha depois, em todo ponto herdado pelo padrão.
      const avisos: string[] = json?.data?.avisos ?? [];
      if (avisos.length > 0) avisos.forEach((a) => toast.warning(t(a)));
      else toast.success(`${t("O padrão agora é")} ${modelId}`);
      await aoSalvar();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="p-4" data-testid="cartao-do-padrao">
      <h2 className="text-base font-semibold">{t("Modelo padrão")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Vale em todo ponto que você não configurou individualmente — hoje,")} {herdam.length}{" "}
        {t("de")} {dados.pontos.length}. {t("Trocar aqui muda todos eles de uma vez.")}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48">
          <Label className="text-xs">{t("Provedor")}</Label>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              // Modelo de outro provedor não vale nada aqui: com catálogo
              // sincronizado a rota confere o par (provider, model_id) e
              // devolveria 404.
              setModelId("");
            }}
          >
            <SelectTrigger data-testid="padrao-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dados.provedores.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {t(p.rotulo)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-64">
          <Label className="text-xs">{t("Modelo")}</Label>
          {/*
            AQUI VALE A MESMA REGRA DO `CartaoDoPonto`, e pelo mesmo motivo: o
            `baseline.sql` semeia `ai_models` só para anthropic/openai/google, e
            os modelos da OpenRouter só chegam quando a sincronização do catálogo
            roda. Numa instalação recém-feita — ou sem scheduler — o combo abria
            com zero opções e o "Salvar padrão" ficava desabilitado, sem nenhum
            caminho para gravar o modelo. Com o catálogo vazio o campo vira texto
            livre, e a rota grava avisando que não deu para conferir o
            identificador.
          */}
          {modelosDoProvedor.length === 0 ? (
            <>
              <Input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="ex.: meta-llama/llama-3.3-70b-instruct"
                data-testid="padrao-modelo"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "O catálogo deste provedor ainda não foi baixado. Digite o identificador do modelo como o provedor o nomeia — a lista completa aparece sozinha depois da primeira sincronização.",
                )}
              </p>
            </>
          ) : (
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger data-testid="padrao-modelo">
                <SelectValue placeholder={t("escolha")} />
              </SelectTrigger>
              <SelectContent>
                {modelosDoProvedor.map((m) => (
                  <SelectItem key={m.model_id} value={m.model_id}>
                    {m.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {dados.podeEditar && (
          <Button
            size="sm"
            disabled={salvando || !mudou || modelId === ""}
            onClick={() => void salvar()}
            data-testid="salvar-padrao"
          >
            {salvando ? t("Salvando…") : t("Salvar padrão")}
          </Button>
        )}
      </div>

      {especialistas.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="padrao-especialistas">
          {especialistas.length}{" "}
          {t(
            "pontos precisam de um modelo especialista (embedding ou áudio) e não seguem este padrão — configure cada um abaixo:",
          )}{" "}
          {especialistas.map((p) => t(p.rotulo)).join(", ")}.
        </p>
      )}
      {midia ? <div className="mt-4 border-t border-border pt-4">{midia}</div> : null}
    </Card>
  );
}
