"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CampoDeData } from "@/components/ui/campo-de-data";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectMercadoPhone } from "@/app/actions/integrations/connectMercadoPhone";
import { importarMercadoPhone } from "@/app/actions/integrations/importarMercadoPhone";
import { disconnectMercadoPhone } from "@/app/actions/integrations/disconnectMercadoPhone";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

const ERROS: Record<string, string> = {
  auth_required: "Faça login para conectar.",
  no_active_org: "Nenhuma organização ativa.",
  forbidden: "Apenas admins podem conectar integrações.",
  invalid_input: "Preencha os dois tokens.",
  invalid_token: "O MercadoPhone recusou o token da API. Confira e tente de novo.",
  api_unavailable: "Não consegui falar com o MercadoPhone agora. Tente de novo em instantes.",
  encrypt_failed: "Não foi possível guardar os tokens com segurança nesta instalação.",
  db_error: "Falha de banco ao conectar.",
  not_connected: "Integração não está conectada.",
};

export function ConexaoMercadoPhone({ conectado, isAdmin, orgId }: { conectado: boolean; isAdmin: boolean; orgId: string | null }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [apiToken, setApiToken] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [desde, setDesde] = useState("");
  const urlDoWebhook = `${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/webhooks/mercadophone?org=${orgId ?? ""}`;

  const falhou = (erro: string) => {
    if (erro === "mfa_required") return irAoDesafioDeMfa();
    toast.error(t(ERROS[erro] ?? `Erro: ${erro}`));
  };

  if (conectado) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mp-desde">{t("Importar vendas desde (até 90 dias)")}</Label>
            <CampoDeData tipo="date" id="mp-desde" value={desde} onValorChange={setDesde} disabled={!isAdmin || pending} />
          </div>
          <Button
            disabled={!isAdmin || pending || !desde}
            onClick={() =>
              start(async () => {
                const res = await importarMercadoPhone({ desde });
                if (!res.ok) return falhou(res.error);
                if (res.parcial) setDesde(res.proximaData ?? desde);
                toast.success(
                  t("{vendas} vendas e {margens} margens importadas.")
                    .replace("{vendas}", String(res.vendas))
                    .replace("{margens}", String(res.margens)) +
                    (res.parcial ? " " + t("Faltou tempo: clique de novo para continuar.") : ""),
                );
              })
            }
          >
            {pending ? t("Importando…") : t("Importar vendas desde")}
          </Button>
        </div>
        <Button
          variant="outline"
          disabled={!isAdmin || pending}
          onClick={() =>
            start(async () => {
              const res = await disconnectMercadoPhone();
              if (res.ok) toast.success(t("MercadoPhone desconectado."));
              else falhou(res.error);
            })
          }
        >
          {pending ? t("Desconectando…") : t("Desconectar")}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await connectMercadoPhone({ apiToken, webhookToken });
          if (res.ok) {
            setApiToken("");
            setWebhookToken("");
            toast.success(t("MercadoPhone conectado."));
          } else falhou(res.error);
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mp-api-token">{t("Token da API")}</Label>
        <Input id="mp-api-token" type="password" autoComplete="off" value={apiToken}
          onChange={(e) => setApiToken(e.target.value)} disabled={!isAdmin || pending} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mp-webhook-token">{t("Token de segurança do webhook")}</Label>
        <Input id="mp-webhook-token" type="password" autoComplete="off" value={webhookToken}
          onChange={(e) => setWebhookToken(e.target.value)} disabled={!isAdmin || pending} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mp-webhook-url">{t("URL do webhook (cole no MercadoPhone)")}</Label>
        <Input id="mp-webhook-url" readOnly value={urlDoWebhook} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <Button type="submit" disabled={!isAdmin || pending || !apiToken.trim() || !webhookToken.trim()}>
        {pending ? t("Conectando…") : t("Conectar MercadoPhone")}
      </Button>
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">{t("Somente administradores podem conectar integrações.")}</p>
      ) : null}
    </form>
  );
}
