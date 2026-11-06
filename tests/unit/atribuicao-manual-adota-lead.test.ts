/**
 * ASSUMIR E TRANSFERIR LEVAM O LEAD JUNTO — o lead aberto do contato vira de quem assumiu
 * (ou do destino), mesmo que já tivesse outro dono.
 *
 * ## O buraco que este arquivo fecha
 *
 * Só o rodízio (`lib/routing/worker.ts`) passava o dono da conversa para o lead.
 * "Assumir" e "Transferir" gravavam `conversations.assigned_to_user_id` e mais
 * nada. Medido no Dr. Paulo em 30/09/2026: com o rodízio parado, as atendentes
 * assumiram dezenas de conversas à mão e 0 de 200 leads em 10 dias ganharam dono.
 *
 * ## Por que o teste olha o UPDATE, e não um mock da função
 *
 * Mockar `adotarLeadsDoContato` provaria que a rota "chamou algo". O que importa
 * é o que chega ao banco: service role bypassa RLS, então o filtro de org tem
 * que vir da SESSÃO, e o filtro `or` (sem dono OU dono diferente do destino) mais
 * `owner_agent_id: null` nos valores é o que faz "assumir = vira dono".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";

interface Update {
  tabela: string;
  valores: Record<string, unknown>;
  filtros: Record<string, unknown>;
}

function montar(assignRows: Array<Record<string, unknown>>) {
  const updates: Update[] = [];
  const supabase = {
    rpc: async (fn: string) =>
      fn === "fn_conversation_assign" ? { data: assignRows, error: null } : { data: null, error: null },
    // #3642: o transfer lê o número de antes da troca (só para a auditoria).
    from() {
      const leitura = {
        select: () => leitura,
        eq: () => leitura,
        maybeSingle: () => Promise.resolve({ data: { channel_session_id: null }, error: null }),
      };
      return leitura;
    },
  };
  const admin = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let valores: Record<string, unknown> | null = null;
      const cadeia: Record<string, unknown> = {
        update(v: Record<string, unknown>) {
          valores = v;
          return cadeia;
        },
        select: () => {
          if (valores) {
            updates.push({ tabela, valores, filtros });
            return Promise.resolve({ data: [{ id: "lead-1" }], error: null });
          }
          return cadeia;
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          return cadeia;
        },
        is(col: string, val: unknown) {
          filtros[`is:${col}`] = val;
          return cadeia;
        },
        or(expr: string) {
          filtros["or"] = expr;
          return cadeia;
        },
        // Checagem de membro do destino no transfer.
        maybeSingle: () => Promise.resolve({ data: { role: "agent" }, error: null }),
      };
      return cadeia;
    },
  };

  const user: AuthUser = {
    id: AGENT_ID,
    email: "agent@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabase as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(admin as any);
  return updates;
}

const conv = (dono: string) => ({
  id: CONV_ID,
  organization_id: ORG_ID,
  contact_id: CONTACT_ID,
  status: "claimed",
  assigned_to_user_id: dono,
});

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: CONV_ID }) };

function updateDoLead(updates: Update[]) {
  return updates.find((u) => u.tabela === "crm_leads");
}

function esperaAdocaoSegura(u: Update | undefined, novoDono: string) {
  expect(u, "a atribuição da conversa não levou o lead junto").toBeDefined();
  expect(u!.valores).toMatchObject({ owner_user_id: novoDono, owner_kind: "user" });
  // Service role bypassa RLS: sem este filtro, o UPDATE alcança outras orgs.
  expect(u!.filtros["eq:organization_id"]).toBe(ORG_ID);
  expect(u!.filtros["eq:contact_id"]).toBe(CONTACT_ID);
  expect(u!.filtros["eq:status"]).toBe("open");
  // Assumir/transferir à mão = vira dono: troca o dono humano ou da IA (agente é limpo)
  // e adota o lead sem dono; só pula quem já é o próprio destino.
  expect(u!.valores).toMatchObject({ owner_agent_id: null });
  expect(u!.valores).toHaveProperty("assigned_at");
  expect(u!.filtros["or"]).toBe(`owner_user_id.is.null,owner_user_id.neq.${novoDono}`);
  expect(u!.filtros["is:owner_user_id"]).toBeUndefined();
  expect(u!.filtros["is:owner_agent_id"]).toBeUndefined();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
});

describe("Assumir faz do atendente o dono do lead (adota o sem dono e troca o de outro)", () => {
  it("claim ok → lead aberto e sem dono do contato vai para o atendente", async () => {
    const updates = montar([conv(AGENT_ID)]);
    const { POST } = await import("@/app/api/v1/conversations/[id]/claim/route");
    const res = await POST(post("claim", {}), params);
    expect(res.status).toBe(200);
    esperaAdocaoSegura(updateDoLead(updates), AGENT_ID);
  });

  it("claim perdido (409) → lead não é tocado", async () => {
    const updates = montar([]);
    const { POST } = await import("@/app/api/v1/conversations/[id]/claim/route");
    const res = await POST(post("claim", {}), params);
    expect(res.status).toBe(409);
    expect(updateDoLead(updates)).toBeUndefined();
  });
});

describe("Transferir faz do DESTINO o dono do lead", () => {
  it("transfer ok → lead vai para o destino, não para quem transferiu", async () => {
    const updates = montar([conv(TARGET_ID)]);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(post("transfer", { to_user_id: TARGET_ID }), params);
    expect(res.status).toBe(200);
    esperaAdocaoSegura(updateDoLead(updates), TARGET_ID);
  });

  it("conversa inexistente (404) → lead não é tocado", async () => {
    const updates = montar([]);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(post("transfer", { to_user_id: TARGET_ID }), params);
    expect(res.status).toBe(404);
    expect(updateDoLead(updates)).toBeUndefined();
  });
});
