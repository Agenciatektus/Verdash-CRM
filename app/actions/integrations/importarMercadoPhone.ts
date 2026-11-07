"use server";

/**
 * Server Action: importa vendas e margens do MercadoPhone desde uma data (até 90 dias atrás).
 * Para em ~50 s e devolve `parcial` + `proximaData` para o admin repetir.
 * shortcut: retoma por data (não por página), então repete o último dia; o upsert é idempotente. Upgrade: job em fila.
 */

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { credenciaisMercadoPhone } from "@/lib/mercadophone/credenciais";
import { buscarCliente, listarHistorico, listarVendas, MercadoPhoneApiError } from "@/lib/mercadophone/api-client";
import { gravarMargens } from "@/lib/mercadophone/margens";
import { gravarVenda } from "@/lib/mercadophone/venda";

export type ImportarMercadoPhoneResult =
  | { ok: true; vendas: number; margens: number; parcial: boolean; proximaData?: string }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "invalid_input" | "not_connected" | "api_unavailable" | "db_error";
    };

const ORCAMENTO_MS = 50_000;
const DIA_MS = 86_400_000;

export async function importarMercadoPhone(input: { desde: string }): Promise<ImportarMercadoPhoneResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!podeAdministrarEmpresa(user, activeOrg)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const desde = String(input?.desde ?? "");
  const t = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? Date.parse(`${desde}T00:00:00Z`) : NaN;
  const hoje = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(t) || desde > hoje || Date.now() - t > 90 * DIA_MS) return { ok: false, error: "invalid_input" };

  const cred = await credenciaisMercadoPhone(activeOrg.orgId);
  if (!cred) return { ok: false, error: "not_connected" };

  const inicio = Date.now();
  const admin = createAdminClient();
  const periodo = { dataVendaInicial: desde, dataVendaFinal: hoje };
  let vendas = 0;
  let margens = 0;
  let proximaData: string | undefined;

  try {
    for (let page = 1; ; page++) {
      const { itens } = await listarVendas(cred.apiToken, { ...periodo, page, limit: 100 });
      for (const v of itens) {
        const tel = (v["cliente"] as Record<string, unknown> | undefined)?.["telefone"];
        if (!tel && v["clienteId"] != null) {
          const c = await buscarCliente(cred.apiToken, String(v["clienteId"]));
          if (c) v["cliente"] = { ...((v["cliente"] as object) ?? {}), nome: (v["cliente"] as { nome?: unknown } | undefined)?.nome ?? c["nome"], telefone: c["telefone"] };
        }
        const r = await gravarVenda(admin, activeOrg.orgId, v).catch(() => ({ status: "error" as const }));
        if (r.status === "ok") vendas++;
      }
      if (itens.length < 100) break;
      if (Date.now() - inicio > ORCAMENTO_MS) {
        proximaData = String(itens[itens.length - 1]?.["dataVenda"] ?? desde).slice(0, 10);
        break;
      }
    }

    if (!proximaData) {
      const contador = new Map<string, number>();
      for (let page = 1; ; page++) {
        const { itens } = await listarHistorico(cred.apiToken, { ...periodo, page, limit: 100 });
        const g = await gravarMargens(admin, activeOrg.orgId, itens, contador);
        if (g.erro) return { ok: false, error: "db_error" };
        margens += g.gravadas;
        if (itens.length < 100) break;
        if (Date.now() - inicio > ORCAMENTO_MS) {
          // Histórico partido: a retomada refaz as vendas do período e recomeça as margens (upsert idempotente).
          proximaData = String(itens[itens.length - 1]?.["dataVenda"] ?? desde).slice(0, 10);
          break;
        }
      }
    }
  } catch (err) {
    if (err instanceof MercadoPhoneApiError) return { ok: false, error: "api_unavailable" };
    return { ok: false, error: "db_error" };
  }

  await audit({
    action: "mercadophone.sales_imported",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "tenant_integration",
    resourceId: activeOrg.orgId,
  });
  return { ok: true, vendas, margens, parcial: !!proximaData, proximaData };
}
