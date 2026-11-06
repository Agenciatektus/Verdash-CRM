import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { totalDeConversasDoIzzy } from "@/lib/channels/historico/fonte-izzy";
import { calcularPrevia, lerSessaoDoHistorico, type SessaoDoHistorico } from "@/lib/channels/historico/previa";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * A importação do histórico do número (#999), pela tela de conexões.
 *
 * A rota NUNCA executa rodada: ela só cria e muda o ESTADO da linha em
 * `importacoes_de_historico`. Quem anda o acervo é o cron
 * (`app/api/v1/cron/historico-import`), uma rodada por importação `rodando` a
 * cada chamada. Assim o clique responde na hora e a importação não depende de
 * a aba ficar aberta.
 *
 * Transições:
 *   - `previa`   → cria linha `previa` com os números (teto de custo na lib);
 *                  409 se o número já tem uma `rodando`;
 *   - `importar` → `previa` → `rodando`;
 *   - `cancelar` → `previa`/`rodando`/`erro` → `cancelada`;
 *   - `retomar`  → `erro` → `rodando`, limpando o erro.
 * Fora disso, 409. Uma `rodando` por número: o índice único parcial da 0761
 * garante, e a rota traduz o 23505 em 409.
 *
 * A tabela só aceita escrita do service role (RLS), daí o cliente admin, e
 * toda cadeia carrega a organização ativa e o número do path.
 */
const TABELA = "importacoes_de_historico";
/** O token do Izzy nunca sai nas respostas. */
function semCredencial<T extends object>(linha: T): Omit<T, "credencial_cifrada"> {
  const { credencial_cifrada: _omitido, ...resto } = linha as T & { credencial_cifrada?: unknown };
  return resto;
}
const ACERVO_DESLIGADO = "Ligue 'Guardar o histórico' e conecte o número de novo";

/** A sessão da org, ou a resposta de erro (404 sem sessão, 500 se o banco falhou). */
async function sessaoOuFalha(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  id: string,
  requestId: string,
): Promise<{ sessao: SessaoDoHistorico } | { resposta: Response }> {
  try {
    const sessao = await lerSessaoDoHistorico(admin, orgId, id);
    if (!sessao) return { resposta: fail("not_found", "Canal não encontrado.", 404, { requestId }) };
    return { sessao };
  } catch (err) {
    logger.error("[historico] leitura da sessão falhou", { requestId, detail: err instanceof Error ? err.message : "erro" });
    return { resposta: fail("internal_error", "Não foi possível ler o canal.", 500, { requestId }) };
  }
}

const corpo = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("previa"),
    dias: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
    fonte: z.literal("izzy").optional(),
    token: z.string().trim().min(8).max(500).optional(),
  }),
  z.object({ acao: z.literal("importar"), importacaoId: z.uuid() }),
  z.object({ acao: z.literal("cancelar"), importacaoId: z.uuid() }),
  z.object({ acao: z.literal("retomar"), importacaoId: z.uuid() }),
]);

/** De onde cada ação pode partir, para onde vai e o que audita. */
const TRANSICOES = {
  importar: { de: ["previa"], para: "rodando", acao: "channel.historico_import_started" },
  cancelar: { de: ["previa", "rodando", "erro"], para: "cancelada", acao: "channel.historico_import_cancelled" },
  retomar: { de: ["erro"], para: "rodando", acao: "channel.historico_import_resumed" },
} as const satisfies Record<string, { de: readonly string[]; para: string; acao: AuditAction }>;

export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const admin = createAdminClient();
  const lida = await sessaoOuFalha(admin, auth.org.orgId, id, requestId);
  if ("resposta" in lida) return lida.resposta;
  const { sessao } = lida;
  const { data, error } = await admin
    .from(TABELA)
    .select("*")
    .eq("organization_id", auth.org.orgId)
    .eq("channel_session_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler a importação.", 500, { requestId });
  return ok({ guardar_historico: sessao.guardarHistorico, importacao: data ? semCredencial(data) : null }, { requestId });
}

export async function POST(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Pedido de importação inválido.", 422, { requestId });

  const orgId = auth.org.orgId;
  const admin = createAdminClient();
  const lida = await sessaoOuFalha(admin, orgId, id, requestId);
  if ("resposta" in lida) return lida.resposta;
  const { sessao } = lida;
  const auditar = (action: AuditAction, metadata: Record<string, unknown>) =>
    void audit({
      action,
      actorUserId: auth.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata,
    });

  const pedido = parsed.data;
  if (pedido.acao === "previa") {
    const doIzzy = pedido.fonte === "izzy";
    if (doIzzy && !pedido.token) return fail("validation_failed", "Informe o token do Izzy.", 422, { requestId });
    if (!doIzzy && (!sessao.guardarHistorico || !sessao.nomeNoCanal)) return fail("state_conflict", ACERVO_DESLIGADO, 409, { requestId });
    // Com uma `rodando` no número, a prévia nova viraria a mais recente no GET e
    // esconderia a que está andando (e o botão de cancelar dela). Duas abas.
    const { data: andando, error: erroDoAndamento } = await admin
      .from(TABELA)
      .select("id")
      .eq("organization_id", orgId)
      .eq("channel_session_id", id)
      .eq("status", "rodando")
      .limit(1)
      .maybeSingle();
    if (erroDoAndamento) return fail("internal_error", "Não foi possível ler a importação.", 500, { requestId });
    if (andando) return fail("state_conflict", "Já há uma importação em andamento neste número.", 409, { requestId });
    let previa;
    let credencial: string | null = null;
    try {
      if (doIzzy) {
        // Valida o token ANTES de criar a importação; a prévia do Izzy é só a contagem de conversas.
        const conversas = await totalDeConversasDoIzzy(pedido.token!);
        previa = { conversas, mensagens: 0, audios: 0, imagens: 0, desde: new Date(Date.now() - pedido.dias * 86_400_000).toISOString(), parcial: true };
      } else {
        previa = await calcularPrevia(sessao.nomeNoCanal!, pedido.dias);
      }
    } catch (err) {
      if (doIzzy && err instanceof Error && err.message === "izzy_nao_autorizado") {
        return fail("validation_failed", "O Izzy recusou esse token. Confira se copiou inteiro e se ainda está ativo.", 422, { requestId });
      }
      logger.warn("[historico] prévia falhou", { requestId, detail: err instanceof Error ? err.message : "erro" });
      return fail("channel_unavailable", doIzzy ? "O Izzy não respondeu. Tente de novo em instantes." : "O servidor do canal não respondeu. Tente de novo em instantes.", 502, { requestId });
    }
    if (doIzzy) {
      credencial = await encryptWebhookSecret(admin, pedido.token!);
      if (!credencial) return fail("internal_error", "Não foi possível guardar o token com segurança.", 500, { requestId });
    }
    // Prévia nova substitui as anteriores: o token delas não fica guardado à toa.
    if (doIzzy) {
      await admin.from(TABELA).update({ credencial_cifrada: null } as never).eq("channel_session_id", id).eq("status", "previa");
    }
    const { data, error } = await admin
      .from(TABELA)
      .insert({
        organization_id: orgId,
        channel_session_id: id,
        status: "previa",
        dias: pedido.dias,
        previa,
        ...(doIzzy ? { fonte: "izzy", credencial_cifrada: credencial } : {}),
        criada_por: auth.user.id,
      } as never)
      .select("*")
      .single();
    if (error || !data) return fail("internal_error", "Não foi possível gravar a prévia.", 500, { requestId });
    const importacao = semCredencial(data as { id: string });
    auditar("channel.historico_previa", { importacao_id: importacao.id, dias: pedido.dias, previa, fonte: doIzzy ? "izzy" : "canal" });
    return ok({ importacao }, { requestId });
  }

  const t = TRANSICOES[pedido.acao];
  const daImportacao = () =>
    admin.from(TABELA).select("id, status, fonte").eq("id", pedido.importacaoId).eq("organization_id", orgId).eq("channel_session_id", id);

  const { data: atual, error: erroDeLeitura } = await daImportacao().maybeSingle();
  if (erroDeLeitura) return fail("internal_error", "Não foi possível ler a importação.", 500, { requestId });
  if (!atual) return fail("not_found", "Importação não encontrada.", 404, { requestId });

  const doIzzy = (atual as { fonte?: string }).fonte === "izzy";
  if (pedido.acao === "importar" && !doIzzy && !sessao.guardarHistorico) {
    return fail("state_conflict", ACERVO_DESLIGADO, 409, { requestId });
  }
  // O token é zerado quando a importação do Izzy termina em erro: retomar exige colar de novo (nova importação).
  if (pedido.acao === "retomar" && doIzzy) {
    return fail("state_conflict", "O token do Izzy já foi descartado. Comece uma nova importação.", 409, { requestId });
  }
  const patch: Record<string, unknown> = { status: t.para, updated_at: new Date().toISOString() };
  if (pedido.acao === "retomar") patch.erro = null;
  if (pedido.acao === "cancelar") patch.credencial_cifrada = null;
  const { data: mudadas, error } = await admin
    .from(TABELA)
    .update(patch as never)
    .eq("id", pedido.importacaoId)
    .eq("organization_id", orgId)
    .eq("channel_session_id", id)
    .in("status", [...t.de])
    .select("*");
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return fail("state_conflict", "Já há uma importação em andamento neste número.", 409, { requestId });
    }
    return fail("internal_error", "Não foi possível mudar a importação.", 500, { requestId });
  }
  const importacao = (mudadas ?? []).map(semCredencial)[0] as { id: string; status: string } | undefined;
  if (!importacao) {
    return fail("invalid_state_transition", "Esta importação não pode mais fazer isso.", 409, { requestId });
  }
  auditar(t.acao, { importacao_id: importacao.id, de: (atual as { status: string }).status, para: t.para });
  return ok({ importacao }, { requestId });
}
