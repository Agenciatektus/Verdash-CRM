"use server";

/** Server Action: desconecta o MercadoPhone da org ativa (status `disconnected`). */

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type DisconnectMercadoPhoneResult =
  | { ok: true }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "not_connected" | "db_error" };

export async function disconnectMercadoPhone(): Promise<DisconnectMercadoPhoneResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!podeAdministrarEmpresa(user, activeOrg)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("tenant_integrations")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "mercadophone")
    .maybeSingle();
  if (lookupErr) return { ok: false, error: "db_error" };
  if (!existing) return { ok: false, error: "not_connected" };

  const { error: updErr } = await admin
    .from("tenant_integrations")
    .update({ status: "disconnected", status_reason: "user_disconnected" })
    .eq("organization_id", activeOrg.orgId)
    .eq("id", existing.id);
  if (updErr) return { ok: false, error: "db_error" };

  await audit({
    action: "mercadophone.disconnected",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "tenant_integration",
    resourceId: existing.id,
  });
  revalidatePath("/app/integrations/mercadophone");
  return { ok: true };
}
