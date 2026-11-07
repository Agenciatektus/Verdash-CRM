"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pilula } from "@/components/ui/pilula";
import { SeloDeAutoria } from "@/components/operacao/SeloDeAutoria";
import { useT } from "@/hooks/i18n/useT";
import type { WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";
import { Copy } from "@/lib/ui/icons";

/** O cartão de uma fonte de captação: estado, destino, último recebimento e o endereço com Copiar. */
export function FonteCard({
  source,
  funil,
  etapa,
  recebimento,
  url,
  aoAbrir,
  aoCopiar,
}: {
  source: WebhookSourceRow;
  funil?: string;
  etapa?: string;
  recebimento: string;
  url: string;
  aoAbrir: () => void;
  aoCopiar: () => void;
}) {
  const t = useT();
  const destino = [funil, etapa].filter(Boolean).join(" › ");
  return (
    <Card className="flex flex-col gap-2 p-4 transition-colors hover:border-accent">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={aoAbrir} className="min-w-0 flex-1 truncate text-left font-semibold text-text hover:underline">
          {source.name}
        </button>
        <Pilula tom={source.is_active ? "ok" : "neutro"}>{source.is_active ? t("Ativa") : t("Pausada")}</Pilula>
      </div>
      {destino ? (
        <p className="truncate text-sm text-muted-foreground">
          {t("Destino")}: {destino}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{recebimento}</p>
      {/* Desligada, ela para de receber contatos e ninguém do outro lado é avisado. */}
      <SeloDeAutoria kind={source.last_change_actor_kind} em={source.last_change_at} />
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-muted px-2 py-1.5 text-xs">{url}</code>
        <Button type="button" variant="secondary" size="icon" aria-label={t("Copiar endereço")} onClick={aoCopiar}>
          <Copy />
        </Button>
      </div>
    </Card>
  );
}
