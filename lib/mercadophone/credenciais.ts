/**
 * Credenciais do MercadoPhone de UMA organização (só o token da API, decifrado; o do webhook não é lido aqui).
 * Service role: o filtro por `organization_id` é manual e obrigatório.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export async function credenciaisMercadoPhone(
  organizationId: string,
): Promise<{ apiToken: string } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("oauth_access_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "mercadophone")
    .eq("status", "healthy")
    .maybeSingle();
  if (error || !data) return null;

  const cifrado = (data as { oauth_access_token_encrypted: string | null }).oauth_access_token_encrypted;
  if (!cifrado) return null;

  const api = await admin.rpc("fn_decrypt_oauth", { ciphertext: cifrado });
  if (api.error || !api.data) return null;
  return { apiToken: String(api.data) };
}
