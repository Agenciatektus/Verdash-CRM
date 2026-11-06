/**
 * POST/DELETE /api/v1/perfil/foto — a foto de perfil de QUEM ESTÁ LOGADO.
 *
 * Não há id no caminho nem no corpo, de propósito: a única pessoa cuja foto esta
 * rota troca é a da sessão. Não existe parâmetro que um atacante possa trocar
 * para gravar a foto de outra pessoa.
 *
 * ── Onde o ponteiro mora: `app_metadata.avatar_path` ─────────────────────────
 *
 * `app_metadata` e NÃO `user_metadata`: o `user_metadata` é gravável pelo próprio
 * usuário direto no GoTrue (`updateUser({ data })`, com a chave pública), então
 * um ponteiro guardado lá poderia ser trocado sem passar por esta rota. O
 * `app_metadata` só muda pela admin API (service_role). Mesmo assim a forma do
 * caminho é conferida na leitura (`fotoDoUsuario`): defesa em profundidade.
 *
 * O GoTrue faz MERGE das chaves de `app_metadata` no `updateUserById` (as de
 * `provider`/`providers` ficam), e `null` remove a chave.
 *
 * ── Ordem ────────────────────────────────────────────────────────────────────
 * modo suporte → sessão → rate limit → tamanho → SVG → bytes → sobe → grava →
 * só então apaga o anterior (ver `lib/fotos/servidor.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { caminhoNovoDaFoto, extensaoDaFoto, fotoDoUsuario, urlDaFotoDoUsuario } from "@/lib/fotos/foto";
import { apagarFoto, lerFotoDoFormulario, subirFoto } from "@/lib/fotos/servidor";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** 10 trocas por pessoa a cada 5 min — a mesma régua do logo. */
const TETO = 10;
const JANELA_SEGUNDOS = 300;

async function caminhoAtual(userId: string): Promise<string | null> {
  const { data } = await createAdminClient().auth.admin.getUserById(userId);
  const valor = (data?.user?.app_metadata as Record<string, unknown> | undefined)?.avatar_path;
  return typeof valor === "string" ? valor : null;
}

async function gravar(userId: string, caminho: string | null, requestId: string): Promise<boolean> {
  // `user_metadata.avatar_url` (a URL colada da tela antiga) sai junto: a tela
  // não oferece mais o campo, e sem isto "Remover" deixaria a URL antiga de volta.
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: { avatar_path: caminho },
    user_metadata: { avatar_url: null },
  });
  if (error) {
    logger.error("[perfil/foto] gravação do ponteiro falhou", { detalhe: error.message, requestId });
    return false;
  }
  // As outras sessões da pessoa leem o `getUser` do cache curto: sem isto a foto fica velha nelas.
  invalidarUsuario(userId);
  return true;
}

async function abrir(req: NextRequest, requestId: string) {
  const user = await loadAuthUser();
  if (!user) return { aberto: false, recusa: fail("unauthenticated", "Faça login.", 401, { requestId }) } as const;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const limite = await checkRateLimit(`perfil-foto:${user.id}`, TETO, JANELA_SEGUNDOS);
  if (!limite.allowed) {
    return {
      aberto: false,
      recusa: fail("rate_limited", t("Muitas trocas de foto seguidas. Tente em alguns minutos."), 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      }),
    } as const;
  }
  const auditar = (definida: boolean) =>
    audit({
      action: "profile.avatar_updated",
      actorUserId: user.id,
      resourceType: "user",
      resourceId: user.id,
      requestId,
      ip: ipDoCliente(req.headers),
      userAgent: req.headers.get("user-agent") ?? null,
      metadata: { foto_definida: definida },
    });
  return { aberto: true, user, t, auditar } as const;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const aberto = await abrir(req, requestId);
  if (!aberto.aberto) return aberto.recusa;
  const { user, t, auditar } = aberto;

  const lido = await lerFotoDoFormulario(req, t, requestId);
  if ("recusa" in lido) return lido.recusa;

  const caminho = caminhoNovoDaFoto("usuario", user.id, extensaoDaFoto(lido.tipo));
  if (!caminho) return fail("internal_error", t("Erro ao subir a foto."), 500, { requestId });

  const anterior = await caminhoAtual(user.id);
  if (!(await subirFoto(caminho, lido.bytes, lido.tipo, requestId))) {
    return fail("internal_error", t("Erro ao subir a foto."), 500, { requestId });
  }
  if (!(await gravar(user.id, caminho, requestId))) {
    // O arquivo NOVO vira órfão; tentar apagá-lo é o certo e não é obrigatório.
    void apagarFoto(caminho, (c) => fotoDoUsuario(c, user.id), requestId);
    return fail("internal_error", t("Erro ao salvar a foto."), 500, { requestId });
  }
  await apagarFoto(anterior, (c) => fotoDoUsuario(c, user.id), requestId);
  await auditar(true);

  return ok({ avatar_url: urlDaFotoDoUsuario(user.id, caminho) }, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const aberto = await abrir(req, requestId);
  if (!aberto.aberto) return aberto.recusa;
  const { user, t, auditar } = aberto;

  const anterior = await caminhoAtual(user.id);
  if (!(await gravar(user.id, null, requestId))) {
    return fail("internal_error", t("Erro ao remover a foto."), 500, { requestId });
  }
  await apagarFoto(anterior, (c) => fotoDoUsuario(c, user.id), requestId);
  await auditar(false);

  return ok({ avatar_url: null }, { requestId });
}
