import { Pagina } from "@/components/pagina";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { WebhooksClient, type AbaDosWebhooks } from "./_components/WebhooksClient";

const ABAS: ReadonlyArray<AbaDosWebhooks> = ["receber", "leads", "automacoes", "atividade"];

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Webhooks" };

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");
  const pedida = (await searchParams).aba;
  const abaInicial = ABAS.find((a) => a === pedida);

  return (
    <Pagina>
      <WebhooksClient abaInicial={abaInicial} />
    </Pagina>
  );
}
