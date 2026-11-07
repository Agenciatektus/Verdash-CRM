"use client";
import * as React from "react";
import { CabecalhoDaPagina, SecaoDaPagina } from "@/components/pagina";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus } from "@/lib/ui/icons";
import { SourcesTab } from "./SourcesTab";
import { RulesTab } from "./RulesTab";
import { ActivityTab } from "./ActivityTab";
import { CapturasTab } from "./CapturasTab";
import { useT } from "@/hooks/i18n/useT";

/** As abas que um link pode abrir direto (`/app/webhooks?aba=automacoes`, a volta do designer). */
const ABAS = { receber: "sources", leads: "capturas", automacoes: "rules", atividade: "activity" } as const;
export type AbaDosWebhooks = keyof typeof ABAS;

export function WebhooksClient({ abaInicial }: { abaInicial?: AbaDosWebhooks }) {
  const t = useT();
  const [aba, setAba] = React.useState<string>(abaInicial ? ABAS[abaInicial] : "sources");
  const [novaFonteAberta, setNovaFonteAberta] = React.useState(false);
  // Radix Tabs gera ids via useId; com SSR streamado (Next 15) os ids divergem
  // entre server e client e o React acusa hydration mismatch. Nenhuma outra
  // página do app SSRa Tabs no primeiro paint (todas montam pós-fetch):
  // skeleton no SSR, Tabs após mount.
  const mounted = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  );

  const cabecalho = (
    <CabecalhoDaPagina
      titulo="Webhooks"
      descricao={t("Receba contatos de fora (landing pages, formulários) e crie automações que agem sozinhas.")}
      acoes={
        mounted && aba === "sources" ? (
          <Button onClick={() => setNovaFonteAberta(true)}>
            <Plus /> {t("Nova fonte")}
          </Button>
        ) : null
      }
    />
  );

  if (!mounted) {
    // Altura do TabsList sublinhado (h-10); `max-w-full` para a fila não empurrar o <main> no celular.
    return (
      <>
        {cabecalho}
        <SecaoDaPagina>
          <Skeleton className="h-10 w-[432px] max-w-full" />
        </SecaoDaPagina>
      </>
    );
  }

  return (
    <>
      {cabecalho}
      <SecaoDaPagina>
        <Tabs value={aba} onValueChange={setAba} className="flex-1">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="sources">{t("Receber dados")}</TabsTrigger>
            <TabsTrigger value="capturas">{t("Leads recebidos")}</TabsTrigger>
            <TabsTrigger value="rules">{t("Automações")}</TabsTrigger>
            <TabsTrigger value="activity">{t("Atividade")}</TabsTrigger>
          </TabsList>
          <TabsContent value="sources">
            <SourcesTab createOpen={novaFonteAberta} onCreateOpenChange={setNovaFonteAberta} />
          </TabsContent>
          <TabsContent value="capturas"><CapturasTab /></TabsContent>
          <TabsContent value="rules"><RulesTab /></TabsContent>
          <TabsContent value="activity"><ActivityTab /></TabsContent>
        </Tabs>
      </SecaoDaPagina>
    </>
  );
}
