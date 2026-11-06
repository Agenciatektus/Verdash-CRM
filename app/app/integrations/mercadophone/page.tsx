import { CabecalhoDaPagina, Pagina, SecaoDaPagina } from "@/components/pagina";
import { Storefront } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { ConexaoMercadoPhone } from "./_components/ConexaoMercadoPhone";

/** MercadoPhone (PDV): sem OAuth, o admin cola o token da API e o do webhook. */
export default async function MercadoPhoneIntegrationPage() {
  const user = await loadAuthUser();
  const activeOrg = user ? await resolveActiveOrg(user) : null;
  const idioma = normalizarIdioma(user?.locale ?? null);

  const { data } = activeOrg
    ? await createAdminClient()
        .from("tenant_integrations")
        .select("status")
        .eq("organization_id", activeOrg.orgId)
        .eq("provider", "mercadophone")
        .maybeSingle()
    : { data: null };
  const status = (data as { status: string } | null)?.status ?? null;
  const conectado = !!status && status !== "disconnected";
  const isAdmin = activeOrg?.role === "admin" || (user?.is_platform_admin === true && !user.support);

  return (
    <Pagina>
      <CabecalhoDaPagina
        titulo={
          <span className="flex items-center gap-3">
            <Storefront size={28} weight="duotone" className="shrink-0 text-muted-foreground" aria-hidden />
            MercadoPhone
          </span>
        }
        descricao={traduzir("Conecta o PDV da loja: estoque, clientes e vendas.", idioma)}
      />
      <SecaoDaPagina className="max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {conectado ? traduzir("Conectado", idioma) : traduzir("Conectar MercadoPhone", idioma)}
              {conectado ? <Badge variant="secondary">{status}</Badge> : null}
            </CardTitle>
            <CardDescription>
              {traduzir("Cole os dois tokens gerados no MercadoPhone e registre a URL do webhook lá.", idioma)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConexaoMercadoPhone conectado={conectado} isAdmin={isAdmin} />
          </CardContent>
        </Card>
      </SecaoDaPagina>
    </Pagina>
  );
}
