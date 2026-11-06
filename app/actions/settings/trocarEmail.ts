"use server";
/**
 * PEDE a troca do e-mail de acesso. Não troca nada sozinha.
 *
 * Quem troca é o GoTrue, quando o link de confirmação é aceito: `updateUser({
 * email })` grava o endereço novo em `auth.users.email_change` (pendente) e manda
 * o link. Com a troca segura do GoTrue (`MAILER_SECURE_EMAIL_CHANGE_ENABLED`, o
 * padrão, ligado no servidor), o link vai para os DOIS endereços e a troca só
 * acontece depois das duas confirmações. Nenhuma tabela do produto recebe o
 * e-mail novo antes disso.
 *
 * ── Travas, na ordem ─────────────────────────────────────────────────────────
 *  1. sessão de verdade (sem modo suporte: quem acompanha não troca a conta de
 *     ninguém);
 *  2. e-mail válido e DIFERENTE do atual;
 *  3. segundo fator em dia (`mfaEmDivida`) — o padrão do projeto para ação
 *     sensível. Quem tem o fator e entrou só com a senha prova o código antes;
 *  4. teto de 3 pedidos por hora por pessoa (o GoTrue tem o dele, global, por
 *     instalação: `GOTRUE_RATE_LIMIT_EMAIL_SENT`);
 *  5. instalação de servidor único sem SMTP: recusa ANTES de chamar o GoTrue,
 *     com a razão (o link nunca chegaria).
 *
 * O link volta em `/auth/confirm?type=email_change&token_hash=…`, com o modelo
 * `email_change` de `/email-templates/[modelo]` — sem esse modelo o GoTrue manda
 * o link PKCE padrão, que não fecha nesta instalação (ver `app/auth/confirm`).
 */
import { headers } from "next/headers";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import { semSmtpNaInstalacao } from "@/lib/email/estado";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

export type TrocarEmailErro =
  | "unauthenticated"
  | "support_readonly"
  | "validation_failed"
  | "same_email"
  | "mfa_required"
  | "rate_limited"
  | "smtp_not_configured"
  | "email_in_use"
  | "update_failed";

export type TrocarEmailResultado = { ok: true; novoEmail: string } | { ok: false; error: TrocarEmailErro };

/** 3 pedidos por hora: cada um manda até dois e-mails. */
const TETO = 3;
const JANELA_SEGUNDOS = 3600;

export async function trocarEmail(input: { email: string }): Promise<TrocarEmailResultado> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (user.support) return { ok: false, error: "support_readonly" };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };
  const novo = parsed.data.email;
  if (novo === user.email.trim().toLowerCase()) return { ok: false, error: "same_email" };

  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const limite = await checkRateLimit(`trocar-email:${user.id}`, TETO, JANELA_SEGUNDOS);
  if (!limite.allowed) return { ok: false, error: "rate_limited" };

  if (await semSmtpNaInstalacao()) return { ok: false, error: "smtp_not_configured" };

  const hdrs = await headers();
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser(
    { email: novo },
    { emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/auth/confirm?type=email_change` },
  );

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    // `email_exists` (GoTrue ≥ 2.1xx) ou a frase antiga. Dizer "em uso" aqui não
    // abre enumeração nova: o cadastro já responde o mesmo para o mesmo endereço.
    if (error.code === "email_exists" || /already (been )?registered/i.test(error.message)) {
      return { ok: false, error: "email_in_use" };
    }
    console.error("[trocarEmail] updateUser falhou", { code: error.code ?? null, status: error.status ?? null });
    return { ok: false, error: "update_failed" };
  }

  // O GoTrue já gravou o pedido (`new_email`) no usuário: o cache curto do `getUser` não pode servir o anterior.
  invalidarUsuario(user.id);

  await audit({
    action: "profile.email_change_requested",
    actorUserId: user.id,
    // A conta é da PESSOA, não de uma organização: o e-mail vale em todas.
    organizationId: null,
    resourceType: "user",
    resourceId: user.id,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
    // O DOMÍNIO e não o endereço: a trilha é lida por quem opera a plataforma.
    metadata: { dominio_novo: novo.slice(novo.lastIndexOf("@") + 1) },
  });

  return { ok: true, novoEmail: novo };
}
