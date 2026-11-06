/**
 * /api/v1/admin/tenants/[id]/assinatura/estorno — o dono da instalação devolve
 * dinheiro de uma empresa.
 *
 *  - GET: a última cobrança paga no provedor, o que já voltou dela e o valor
 *    sugerido pela regra (`lib/cobranca/estorno.ts`). Só lê.
 *  - POST {valor_cents}: estorna esse valor da última cobrança. O valor é do dono
 *    (a sugestão é só ponto de partida), limitado ao saldo da cobrança, relido
 *    no provedor na hora. Repetir o mesmo clique não estorna duas vezes
 *    (chave de idempotência = cobrança + saldo estornado + valor).
 *
 * Estornar não cancela a assinatura nem o contrário: são dois botões.
 */
import { type NextRequest, type NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { lerOrgDoTenant } from "@/lib/cobranca/dono";
import { sugerirEstorno } from "@/lib/cobranca/estorno";
import { limiteDoProvedorPorOrg, recusaDoProvedor } from "@/lib/cobranca/falhas";
import { adaptador } from "@/lib/cobranca/provedores";
import type { AdaptadorDeCobranca, CobrancaEstornavel } from "@/lib/cobranca/provedores/contrato";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

// `cobranca_ref` e `estornado_cents_visto` só são COMPARADOS com o que o provedor devolve agora (nunca usados como fonte):
// a segunda tentativa depois de um timeout enxerga o saldo mudado e recusa em vez de estornar de novo.
const corpoSchema = z.strictObject({
  valor_cents: z.number().int().positive(),
  cobranca_ref: z.string().min(1).max(100),
  estornado_cents_visto: z.number().int().nonnegative(),
});
type Rota = { params: Promise<{ id: string }> };

/** Linha da assinatura + a cobrança lida no provedor. `resposta` é a recusa pronta. */
type Lida =
  | { resposta: NextResponse<ApiError> }
  | { resposta?: undefined; prov: AdaptadorDeCobranca; cobranca: CobrancaEstornavel | null; intervalo: "mes" | "ano" };

async function ler(admin: ReturnType<typeof createAdminClient>, tenantId: string, requestId: string): Promise<Lida> {
  const { data, error } = await admin
    .from("cobranca_assinaturas")
    // Três chaves levam ao plano (atual, agendado, troca pendente): sem a dica o embed é ambíguo e o PostgREST recusa.
    .select("provedor, provedor_cliente_id, plano:cobranca_planos!cobranca_assinaturas_plano_id_fkey(intervalo)")
    .eq("organization_id", tenantId)
    .maybeSingle();
  if (error) return { resposta: fail("internal_error", "Não foi possível ler a assinatura", 500, { requestId }) };
  const linha = data as { provedor: ProvedorDeCobranca | null; provedor_cliente_id: string | null; plano: { intervalo: "mes" | "ano" } | { intervalo: "mes" | "ano" }[] | null } | null;
  if (!linha?.provedor || !linha.provedor_cliente_id) {
    return { resposta: fail("state_conflict", "Esta empresa não tem pagamento no provedor.", 409, { requestId }) };
  }
  const prov = adaptador(linha.provedor);
  if (!prov.lerUltimaCobranca || !prov.estornarCobranca) {
    return { resposta: fail("estorno_nao_suportado", "Este provedor não faz estorno por aqui. Estorne no painel dele.", 409, { requestId }) };
  }
  const plano = Array.isArray(linha.plano) ? linha.plano[0] : linha.plano;
  try {
    const cobranca = await prov.lerUltimaCobranca({ clienteRef: linha.provedor_cliente_id });
    return { prov, cobranca, intervalo: plano?.intervalo ?? "mes" };
  } catch (e) {
    const r = recusaDoProvedor(e);
    return { resposta: fail(r.code, r.message, r.status, { requestId }) };
  }
}

export async function GET(_req: NextRequest, { params }: Rota) {
  const { id: tenantId } = await params;
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch (err) {
    // A recusa nomeada (mfa_required) sobrevive: um catch próprio a engolia como `forbidden`.
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(tenantId).success) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  if (!(await limiteDoProvedorPorOrg(tenantId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, { requestId, headers: { "Retry-After": "60" } });
  }
  const r = await ler(admin, tenantId, requestId);
  if (r.resposta) return r.resposta;
  if (!r.cobranca) return ok({ cobranca: null, sugestao: null }, { requestId });
  const sugestao = sugerirEstorno(r.cobranca, r.intervalo);
  return ok(
    {
      cobranca: { ref: r.cobranca.ref, valor_cents: r.cobranca.valorCents, estornado_cents: r.cobranca.estornadoCents, moeda: r.cobranca.moeda, paga_em: r.cobranca.pagaEm.toISOString() },
      sugestao,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest, { params }: Rota) {
  const { id: tenantId } = await params;
  const supportDenied = await requireSupportWrite(tenantId);
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(tenantId).success) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o valor do estorno", 400, { requestId, details: corpo.error.flatten() });
  }
  const org = await lerOrgDoTenant(admin, tenantId);
  if (org === "erro") return fail("internal_error", "Não foi possível ler a empresa", 500, { requestId });
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });
  if (!(await limiteDoProvedorPorOrg(tenantId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const r = await ler(admin, tenantId, requestId);
  if (r.resposta) return r.resposta;
  const c: CobrancaEstornavel | null = r.cobranca;
  if (!c) return fail("state_conflict", "Não há cobrança paga para estornar.", 409, { requestId });
  if (c.ref !== corpo.data.cobranca_ref || c.estornadoCents !== corpo.data.estornado_cents_visto) {
    return fail("state_conflict", "O pagamento mudou desde que você abriu a tela (outro estorno ou nova cobrança). Recarregue e confira antes de estornar.", 409, { requestId });
  }
  const saldo = c.valorCents - c.estornadoCents;
  if (corpo.data.valor_cents > saldo) {
    return fail("validation_failed", "O valor passa do que ainda pode ser estornado.", 422, { requestId, details: { saldo_cents: saldo } });
  }

  try {
    await r.prov.estornarCobranca!({
      cobrancaRef: c.ref,
      valorCents: corpo.data.valor_cents,
      chaveIdempotencia: `estorno:${tenantId}:${c.ref}:${corpo.data.estornado_cents_visto}:${corpo.data.valor_cents}`,
    });
  } catch (e) {
    const rec = recusaDoProvedor(e);
    if (rec.status === 503) {
      // Ambíguo: a Stripe pode ter estornado e a resposta ter se perdido. Deixa rastro e manda conferir antes de repetir.
      void audit({
        action: "cobranca.estorno_incerto",
        actorUserId: adminCtx.user.id,
        actingAsPlatformAdmin: true,
        bypassedRls: true,
        organizationId: tenantId,
        resourceType: "cobranca_assinatura",
        resourceId: tenantId,
        requestId,
        metadata: { valor_cents: corpo.data.valor_cents, cobranca: c.ref },
      });
      return fail("provedor_indisponivel", "O provedor não confirmou o estorno. Pode ter sido feito: recarregue a tela e confira o saldo antes de tentar de novo.", 503, { requestId });
    }
    return fail(rec.code, rec.message, rec.status, { requestId });
  }

  void audit({
    action: "cobranca.estorno_feito",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "cobranca_assinatura",
    resourceId: tenantId,
    requestId,
    metadata: { valor_cents: corpo.data.valor_cents, cobranca: c.ref, moeda: c.moeda },
  });
  return ok({ estornado_cents: corpo.data.valor_cents }, { requestId });
}
