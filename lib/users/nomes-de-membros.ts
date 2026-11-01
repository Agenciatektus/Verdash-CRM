/**
 * Nome (e e-mail, para quem precisa) de membros de UMA organização, numa
 * chamada só ao banco (`fn_nomes_de_membros`, migration 9088).
 *
 * Substitui o laço de `auth.admin.getUserById`, que fazia uma ida HTTP ao
 * GoTrue por membro (~60 ms cada). Só devolve quem tem ou teve vínculo com
 * `orgId`: id de outra org vem ausente do mapa, nunca com nome.
 *
 * Sem service role, ou com erro do banco, o mapa vem VAZIO: o chamador cai no
 * rótulo genérico e a leitura continua (nome é cortesia, o id é a verdade).
 * `orgId` tem de vir de fonte confiável (cookie validado), nunca do corpo.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface MembroIdentificado {
  full_name: string | null;
  email: string | null;
  last_sign_in_at: string | null;
}

export async function nomesDeMembros(
  orgId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, MembroIdentificado>> {
  const unicos = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unicos.length === 0 || !isServiceRoleConfigured()) return new Map();

  const { data, error } = await createAdminClient().rpc("fn_nomes_de_membros", {
    p_org: orgId,
    p_user_ids: unicos,
  });
  if (error) {
    logger.warn("[nomes-de-membros] rpc falhou", { membros: unicos.length, erro: error.message });
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ user_id: string } & MembroIdentificado>).map((r) => [r.user_id, { full_name: r.full_name ?? null, email: r.email ?? null, last_sign_in_at: r.last_sign_in_at ?? null }]),
  );
}
