/**
 * GET /api/v1/channel-sessions/[id]/groups/estado?group_chat_id=... — o papel deste número no grupo e se só
 * administradores enviam, lidos do diretório (cache), para a inbox travar o composer sem ir ao WhatsApp.
 * Qualquer usuário da inbox; a organização vem da sessão autenticada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const chatSchema = z.string().regex(/^[\d-]+@g\.us$/);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await ctx.params).id);
  const chat = chatSchema.safeParse(req.nextUrl.searchParams.get("group_chat_id"));
  if (!id.success || !chat.success) return fail("validation_error", "dados inválidos", 400, { requestId });
  const { data, error } = await createAdminClient()
    .from("channel_session_group_directory")
    .select("papel, is_announce")
    .eq("organization_id", authz.org.orgId)
    .eq("channel_session_id", id.data)
    .eq("group_chat_id", chat.data)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler o grupo.", 500, { requestId });
  return ok(data ? { papel: data.papel, is_announce: data.is_announce } : { papel: null, is_announce: false }, { requestId });
}
