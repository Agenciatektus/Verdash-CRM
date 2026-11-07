"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import * as React from "react";
import { formatDistanceToNowStrict } from "date-fns";

import { Button } from "@/components/ui/button";
import { Aviso } from "@/components/ui/aviso";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus } from "@/lib/ui/icons";
import {
  usePipelines,
  usePipelineStages,
  useWebhookSources,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";
import { CreateSourceDialog } from "./CreateSourceDialog";
import { FonteCard } from "./FonteCard";
import { SourceDetail, copy, publicUrl } from "./SourceDetail";
import { useT } from "@/hooks/i18n/useT";

function lastReceivedLabel(iso: string | null, t: (texto: string) => string, locale: Locale): string {
  if (!iso) return t("nunca recebeu");
  return `${t("último recebimento")} ${formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: locale })}`;
}

/** Busca o nome do funil e da etapa só do destino desta fonte (o cache do react-query divide por funil). */
function FonteComDestino({ source, onAbrir }: { source: WebhookSourceRow; onAbrir: () => void }) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const { data: pipelinesRes } = usePipelines();
  const { data: boardRes } = usePipelineStages(source.default_pipeline_id);
  const funil = pipelinesRes?.data?.find((p) => p.id === source.default_pipeline_id)?.name;
  const etapa = boardRes?.data?.stages?.find((s) => s.id === source.default_stage_id)?.name;
  const url = publicUrl(source.path_token);
  return (
    <FonteCard
      source={source}
      funil={funil}
      etapa={etapa}
      recebimento={lastReceivedLabel(source.last_received_at, t, localeDaData)}
      url={url}
      aoAbrir={onAbrir}
      aoCopiar={() => copy(url, t("Endereço copiado."), t)}
    />
  );
}

export function SourcesTab({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { data, isLoading } = useWebhookSources();
  const [selected, setSelected] = React.useState<WebhookSourceRow | null>(null);

  const sources = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="grid gap-3 pt-4 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      {sources.length === 0 ? (
        <Aviso
          tom="info"
          titulo={t("Conecte sua landing page em 2 minutos")}
          acao={
            <Button size="sm" onClick={() => onCreateOpenChange(true)}>
              <Plus /> {t("Criar primeira fonte")}
            </Button>
          }
        >
          <ol className="space-y-1">
            <li>{t("1. Crie uma fonte e diga em qual funil o contato entra.")}</li>
            <li>{t("2. Copie o endereço ou o formulário pronto.")}</li>
            <li>{t("3. Cole no seu site — cada envio vira um lead aqui dentro.")}</li>
          </ol>
        </Aviso>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((s) => (
            <FonteComDestino key={s.id} source={s} onAbrir={() => setSelected(s)} />
          ))}
        </div>
      )}

      <CreateSourceDialog open={createOpen} onOpenChange={onCreateOpenChange} onCreated={setSelected} />
      {selected ? (
        <SourceDetail source={selected} open={!!selected} onOpenChange={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
