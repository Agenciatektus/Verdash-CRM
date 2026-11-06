/**
 * Credenciais do MercadoPhone de UMA organização (tokens já decifrados).
 * Service role: o filtro por `organization_id` é manual e obrigatório.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export async function credenciaisMercadoPhone(
  organizationId: string,
): Promise<{ apiToken: string; webhookToken: string } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("oauth_access_token_encrypted, webhook_secret_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "mercadophone")
    .eq("status", "healthy")
    .maybeSingle();
  if (error || !data) return null;

  const row = data as { oauth_access_token_encrypted: string | null; webhook_secret_encrypted: string | null };
  if (!row.oauth_access_token_encrypted || !row.webhook_secret_encrypted) return null;

  const [api, hook] = await Promise.all([
    admin.rpc("fn_decrypt_oauth", { ciphertext: row.oauth_access_token_encrypted }),
    admin.rpc("fn_decrypt_oauth", { ciphertext: row.webhook_secret_encrypted }),
  ]);
  if (api.error || !api.data || hook.error || !hook.data) return null;
  return { apiToken: String(api.data), webhookToken: String(hook.data) };
}
