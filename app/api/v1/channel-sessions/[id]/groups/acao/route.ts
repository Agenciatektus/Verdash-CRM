/**
 * POST /api/v1/channel-sessions/[id]/groups/acao — gestão de UM grupo pelo painel da inbox.
 * `info` (ver o grupo): qualquer usuário da inbox. O resto muda o grupo no WhatsApp: gerente ou administrador.
 * A organização vem da sessão autenticada, nunca do body. Contrato das ações: `lib/grupos/acoes.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { GrupoAcaoError, montarChamada } from "@/lib/grupos/acoes";
import { criarDepsDeGestao, executarAcaoDeGrupo } from "@/lib/grupos/gestao";
import { GrupoError } from "@/lib/grupos/servico";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const corpoSchema = z.object({ group_chat_id: z.string().max(60), acao: z.string().max(40) }).passthrough();

const STATUS_DO_GRUPO: Record<GrupoError["code"], number> = {
  sessao_nao_encontrada: 404,
  grupo_nao_encontrado: 404,
  canal_sem_grupos: 409,
  filtro_nao_confirmado: 502,
  grupo_desligado: 409,
};

const MENSAGEM_DE_VALIDACAO: Record<string, string> = {
  grupo_invalido: "Grupo inválido.",
  acao_invalida: "Ação inválida.",
  nome_invalido: "O nome do grupo precisa ter de 1 a 100 caracteres.",
  descricao_invalida: "A descrição pode ter no máximo 2048 caracteres.",
  valor_invalido: "Valor inválido.",
  duracao_invalida: "Duração inválida.",
  foto_invalida: "A foto precisa ser um JPEG de até 2 MB.",
  operacao_invalida: "Operação inválida.",
  telefones_invalidos: "Informe de 1 a 20 telefones válidos, com DDI e DDD.",
};

function falhaDaAcao(err: unknown, requestId: string): Response {
  if (err instanceof GrupoError) {
    return fail(err.code, err.code === "grupo_nao_encontrado" ? "Grupo não encontrado neste número." : err.code, STATUS_DO_GRUPO[err.code], { requestId });
  }
  if (err instanceof GrupoAcaoError) {
    switch (err.code) {
      case "whatsapp_recusou":
        return fail(err.code, `O WhatsApp recusou a ação${err.motivo ? ` (${err.motivo})` : ""}. Confira se este número é administrador do grupo.`, 422, { requestId });
      case "instancia_desconectada":
        return fail(err.code, "O WhatsApp deste número está desconectado. Reconecte e tente de novo.", 502, { requestId });
      case "fzap_timeout":
        return fail(err.code, "O WhatsApp demorou para responder. Tente de novo.", 504, { requestId });
      case "fzap_indisponivel":
        return fail(err.code, "O serviço de WhatsApp está indisponível agora. Tente de novo em instantes.", 502, { requestId });
    }
  }
  logger.error("grupos: a ação do grupo falhou", { requestId, causa: err instanceof Error ? err.message : String(err) });
  return fail("internal_error", "Não foi possível concluir a ação. Tente de novo.", 500, { requestId });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const id = idSchema.safeParse((await ctx.params).id);
  // A foto (~2,8 MB em base64) é o maior corpo legítimo.
  if (Number(req.headers.get("content-length") ?? 0) > 3_200_000) {
    return fail("validation_error", "Arquivo grande demais.", 413, { requestId });
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !corpo.success) return fail("validation_error", "dados inválidos", 400, { requestId });

  const { group_chat_id: groupChatId, ...resto } = corpo.data;
  const entrada: Record<string, unknown> = { ...resto, groupChatId };
  // Papel pela ação: ver o grupo é leitura; qualquer outra (ou ação desconhecida) exige gerente.
  const leitura = entrada.acao === "info";
  if (!leitura) {
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
  }
  const authz = await requireRole(leitura ? "agent" : "manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  if (leitura) {
    // `info` traz telefone e nome de cada participante: só para quem ENXERGA a conversa do grupo (RLS do
    // usuário aplica `own`/`own_and_unassigned`), não para qualquer um que saiba o JID.
    const supabase = await createClient();
    const { data: visivel } = await supabase
      .from("conversations")
      .select("id")
      .eq("channel_session_id", id.data)
      .eq("group_chat_id", groupChatId)
      .limit(1);
    if (!visivel?.length) return fail("not_found", "Grupo não encontrado.", 404, { requestId });
  }

  const chamada = montarChamada(entrada);
  if (typeof chamada === "string") return fail("validation_error", MENSAGEM_DE_VALIDACAO[chamada] ?? chamada, 400, { requestId });

  try {
    const data = await executarAcaoDeGrupo(criarDepsDeGestao(), {
      organizationId: authz.org.orgId,
      channelSessionId: id.data,
      entrada,
      chamada,
      actorUserId: authz.user.id,
      requestId,
    });
    return ok(data, { requestId });
  } catch (err) {
    return falhaDaAcao(err, requestId);
  }
}
