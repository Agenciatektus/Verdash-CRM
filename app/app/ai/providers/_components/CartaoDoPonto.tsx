"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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

import { jevNoPonto, type DadosDoJev } from "./CartaoDoJev";
import type { Dados, Ponto } from "./tipos";

export function CartaoDoPonto({
  ponto,
  dados,
  jev,
  aoSalvar,
}: {
  ponto: Ponto;
  dados: Dados;
  jev: DadosDoJev | null;
  aoSalvar: () => Promise<void>;
}) {
  const t = useT();
  const oJevAqui = jevNoPonto(jev, ponto.id);
  const [provider, setProvider] = useState(ponto.efetivo.provider);
  const [modelId, setModelId] = useState(ponto.efetivo.modelId ?? "");
  const [credentialId, setCredentialId] = useState(ponto.efetivo.credentialId ?? "");
  const [baseUrl, setBaseUrl] = useState(ponto.efetivo.baseUrl ?? "");
  const [salvando, setSalvando] = useState(false);

  const modelosDoProvider = dados.modelos.filter((m) => m.provider === provider);
  const credsDoProvider = dados.credenciais.filter((c) => c.provider === provider);
  // Endpoint próprio só faz sentido em provedor compatível com a API da OpenAI
  // — é a mesma condição que `lib/ai/pontos/provedores.ts` declara e que o
  // registry aplica junto da allowlist do egress.
  const aceitaEndpointProprio =
    dados.provedores.find((p) => p.id === provider)?.aceitaEndpointProprio === true;

  const editavel = dados.podeEditar && ponto.fixo === null && !ponto.mandadoPeloAgente;

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ai/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: ponto.id,
          provider,
          model_id: modelId,
          credential_id: credentialId || null,
          // A coluna existia, o PUT a aceitava e o registry a honrava — e nada
          // na tela a enviava. Quem quisesse apontar para um gateway próprio (o
          // caso declarado como motivação da coluna, e o degrau para modelo
          // local) só conseguia pela API. Configuração sem superfície é
          // capacidade que ninguém alcança.
          base_url: aceitaEndpointProprio && baseUrl.trim() !== "" ? baseUrl.trim() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // A mensagem do servidor é escrita para leigo (ver validar-binding.ts).
        // `t()` repassa direto quando não há entrada no dicionário — não é
        // traduzir de novo, é a mesma degradação graciosa do resto do app.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      const avisos: string[] = json?.data?.avisos ?? [];
      if (avisos.length > 0) avisos.forEach((a) => toast.warning(t(a)));
      else toast.success(`"${t(ponto.rotulo)}" ${t("agora usa")} ${modelId}`);
      await aoSalvar();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="p-4" data-testid={`ponto-${ponto.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{t(ponto.rotulo)}</h3>
            {ponto.exige.tools && (
              <Badge variant="outline" className="text-xs">
                {t("precisa de ferramentas")}
              </Badge>
            )}
            {ponto.fixo && (
              <Badge variant="secondary" className="text-xs">
                {t("fixo")}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t(ponto.oQueFaz)}</p>
          {/* O modelo deste cartão continua valendo com o Jev ligado — como
              reserva, ou como quem decide enquanto o Jev só observa. */}
          {oJevAqui && (
            <p className="mt-1 text-xs text-accent" data-testid={`jev-no-ponto-${ponto.id}`}>
              {oJevAqui === "observacao"
                ? t("O Jev observa; o modelo abaixo ainda decide.")
                : oJevAqui === "sozinho"
                  ? t("O Jev mede sozinho: não há modelo de reserva.")
                  : t(oJevAqui.decide)}
            </p>
          )}
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div className="font-mono">{ponto.efetivo.modelId ?? "—"}</div>
          <div data-testid={`origem-${ponto.id}`}>{t(ponto.efetivo.porQue)}</div>
        </div>
      </div>

      {/* O que a pessoa VÊ quando este ponto falha. É a razão de a tela existir. */}
      <p className="mt-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
        <span className="font-medium">{t("Se falhar:")}</span> {t(ponto.sintomaDeFalha)}
      </p>

      {ponto.avisos.map((a) => (
        <p
          key={a}
          className="mt-2 rounded-md bg-warning-bg p-2 text-xs text-warning-fg"
          data-testid={`aviso-${ponto.id}`}
        >
          {t(a)}
        </p>
      ))}

      {ponto.fixo && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`razao-fixo-${ponto.id}`}>
          {t(ponto.fixo.razao)}
        </p>
      )}

      {ponto.mandadoPeloAgente && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("Este ponto usa o modelo definido na versão publicada do agente.")}{" "}
          <Link className="underline underline-offset-4" href="/app/ai/agents">
            {t("Configurar no agente")}
          </Link>
        </p>
      )}

      {editavel && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs">{t("Provedor")}</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                setModelId("");
                setCredentialId("");
              }}
            >
              <SelectTrigger data-testid={`provider-${ponto.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dados.provedores.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.rotulo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{t("Modelo")}</Label>
            {/*
              Catálogo vazio não pode ser beco sem saída. O `baseline.sql` semeia
              `ai_models` só para anthropic/openai/google; os da OpenRouter só
              chegam quando o cron diário roda. Numa VPS recém-instalada, quem
              escolhia OpenRouter via um combo com zero opções e o Salvar
              desabilitado — travado até as 04h15 do dia seguinte, e para sempre
              num deploy sem scheduler. Aqui o campo vira texto livre: a API já
              aceita modelo fora do catálogo e devolve o aviso de que não
              conhece (`validar-binding.ts`, `conhecido: false`).
            */}
            {modelosDoProvider.length === 0 ? (
              <>
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="ex.: meta-llama/llama-3.3-70b-instruct"
                  data-testid={`modelo-${ponto.id}`}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    "O catálogo deste provedor ainda não foi baixado. Digite o identificador do modelo como o provedor o nomeia — a lista completa aparece sozinha depois da primeira sincronização.",
                  )}
                </p>
              </>
            ) : (
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                  <SelectValue placeholder={t("escolha")} />
                </SelectTrigger>
                <SelectContent>
                  {modelosDoProvider.map((m) => (
                    <SelectItem key={m.model_id} value={m.model_id}>
                      {m.display_name}
                      {ponto.exige.tools && !m.supports_tools ? ` — ${t("sem ferramentas")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <Label className="text-xs">{t("Chave")}</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger data-testid={`chave-${ponto.id}`}>
                <SelectValue placeholder={t("da instalação")} />
              </SelectTrigger>
              <SelectContent>
                {credsDoProvider.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label} ••{c.api_key_last4 ?? "??"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {aceitaEndpointProprio && (
            <div className="sm:col-span-3">
              <Label className="text-xs">{t("Endereço próprio (opcional)")}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://mi-gateway.ejemplo.com/v1"
                data-testid={`base-url-${ponto.id}`}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "Deixe em branco para usar o endereço oficial do provedor. Use isto para apontar para um gateway compatível com a API da OpenAI. Um endereço na rede do servidor só funciona se quem administra a instalação o tiver liberado em Administração › Destinos internos — e, mesmo liberado, ele não vale para o endereço que esta empresa escolhe aqui.",
                )}
              </p>
            </div>
          )}

          <div className="sm:col-span-3">
            <Button
              size="sm"
              disabled={salvando || !modelId}
              onClick={() => void salvar()}
              data-testid={`salvar-${ponto.id}`}
            >
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
