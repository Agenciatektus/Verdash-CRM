import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { CabecalhoDaPagina, Pagina, SecaoDaPagina } from "@/components/pagina";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FlowsList } from "./_components/FlowsList";
import { QueueTab } from "./_components/QueueTab";

export const dynamic = "force-dynamic";

const FLOW_COLUMNS = "id, name, status, active_version_id, handoff_policy, updated_at";

export default async function FollowupFlowsPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // Fluxos (edição) segue exigindo manager+; a Fila (leitura) é de qualquer
  // member — o gate por tela fica dentro das abas (canWrite), não na rota.

  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_flow_pointers")
    .select(FLOW_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    // Roteiro de atendimento não é follow-up (prova do #1130): tem tela própria.
    .neq("surface", "atendimento")
    .order("updated_at", { ascending: false });

  const flows = (data ?? []) as unknown as FollowupFlowPointerRow[];
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <Pagina>
      <CabecalhoDaPagina
        titulo="Follow-ups"
        descricao={t("Fluxos automáticos de reengajamento — silêncio, etapa, webhook ou resposta do contato, sem intervenção em cada mensagem.")}
      />
      <Tabs defaultValue="fluxos" className="flex flex-1 flex-col">
        <TabsList className="mb:mx-4">
          <TabsTrigger value="fluxos">{t("Fluxos")}</TabsTrigger>
          <TabsTrigger value="fila">{t("Fila")}</TabsTrigger>
        </TabsList>
        <TabsContent value="fluxos">
          <SecaoDaPagina>
            <FlowsList initialData={flows} canWrite={canWrite} />
          </SecaoDaPagina>
        </TabsContent>
        <TabsContent value="fila">
          <QueueTab canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </Pagina>
  );
}
