"use server";

/**
 * Server Action: conecta o MercadoPhone (PDV) da org ativa.
 * Sem OAuth: o admin cola o token da API e o token de segurança do webhook.
 * A API é chamada uma vez (estoque, limit 1) antes de gravar: token inválido é recusado.
 */

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { listarEstoque, MercadoPhoneApiError } from "@/lib/mercadophone/api-client";

export type ConnectMercadoPhoneResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "auth_required" | "no_active_org" | "forbidden" | "mfa_required"
        | "invalid_input" | "invalid_token" | "api_unavailable" | "encrypt_failed" | "db_error";
    };

export async function connectMercadoPhone(input: {
  apiToken: string;
  webhookToken: string;
}): Promise<ConnectMercadoPhoneResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!podeAdministrarEmpresa(user, activeOrg)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const apiToken = String(input?.apiToken ?? "").trim();
  const webhookToken = String(input?.webhookToken ?? "").trim();
  if (!apiToken || !webhookToken) return { ok: false, error: "invalid_input" };

  try {
    await listarEstoque(apiToken, { page: 1, limit: 1 });
  } catch (err) {
    const recusa = err instanceof MercadoPhoneApiError && (err.code === "unauthorized" || err.code === "forbidden");
    return { ok: false, error: recusa ? "invalid_token" : "api_unavailable" };
  }

  const admin = createAdminClient();
  const [api, hook] = await Promise.all([
    admin.rpc("fn_encrypt_oauth", { plaintext: apiToken }),
    admin.rpc("fn_encrypt_oauth", { plaintext: webhookToken }),
  ]);
  if (api.error || !api.data || hook.error || !hook.data) return { ok: false, error: "encrypt_failed" };

  const { data: integration, error } = await admin
    .from("tenant_integrations")
    .upsert(
      {
        organization_id: activeOrg.orgId,
        provider: "mercadophone",
        oauth_access_token_encrypted: api.data,
        webhook_secret_encrypted: hook.data,
        status: "healthy",
        status_reason: null,
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();
  if (error || !integration) return { ok: false, error: "db_error" };

  await audit({
    action: "mercadophone.connected",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "tenant_integration",
    resourceId: (integration as { id: string }).id,
  });
  revalidatePath("/app/integrations/mercadophone");
  return { ok: true };
}
