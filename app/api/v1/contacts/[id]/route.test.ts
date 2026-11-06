import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET, PATCH } from "./route";

/**
 * AS OBSERVAÇÕES DO CONTATO PELA ROTA (migration 9041).
 *
 * O que se guarda: (1) quem grava é agent+, pela MESMA guarda do resto do
 * PATCH; (2) suporte em modo somente leitura é barrado antes de qualquer
 * consulta; (3) o texto chega ao banco já com trim, e vazio vira null; (4) o
 * audit e o evento dizem QUE mudou, nunca O QUE se escreveu; (5) o GET (a
 * ficha) pede a coluna.
 */

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "90410000-0000-4000-8000-000000000001";
const CONTATO = "90410000-0000-4000-8000-0000000000c1";
const USUARIO = "90410000-0000-4000-8000-0000000000a1";
const SEGREDO = "cliente prefere ligação depois das 18h";

let enviado: Record<string, unknown> | null;
let colunasPedidas: string[];
let eventos: Array<Record<string, unknown>>;
let estado: Record<string, unknown>;

function clienteFalso() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USUARIO } }, error: null }) },
    from: (tabela: string) => {
      if (tabela === "conversations") {
        // O GET anexa a conversa mais recente: nenhuma, aqui.
        const q = { select: () => q, eq: () => q, in: () => q, order: async () => ({ data: [], error: null }) };
        return q;
      }
      if (tabela === "contact_phones") {
        // Telefones extras da ficha (9041 do upstream): nenhum, aqui.
        const q = { select: () => q, eq: () => q, order: async () => ({ data: [], error: null }) };
        return q;
      }
      if (tabela === "organizations") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { country: "BR" }, error: null }) };
        return q;
      }
      const q = {
        select: (cols: string) => { colunasPedidas.push(cols); return q; },
        update: (patch: Record<string, unknown>) => { enviado = patch; return q; },
        eq: () => q,
        maybeSingle: async () => ({ data: { ...estado, ...(enviado ?? {}) }, error: null }),
      };
      return q;
    },
    rpc: (_nome: string, args: Record<string, unknown>) => {
      eventos.push(args);
      return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
    },
  };
}

const ctx = { params: Promise.resolve({ id: CONTATO }) };
const patchReq = (corpo: unknown) =>
  new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  enviado = null;
  colunasPedidas = [];
  eventos = [];
  estado = { id: CONTATO, organization_id: ORG, is_anonymized: false, tags: [], consent: {}, observacoes: null };
  vi.mocked(createClient).mockResolvedValue(clienteFalso() as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USUARIO, idioma: "pt-BR", support: null } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, role: "agent" } as never);
  // O GET resolve a org por `orgAtivaDaApi` (403 JSON), não por `resolveActiveOrg`.
  vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: { orgId: ORG, role: "agent" } } as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("PATCH /api/v1/contacts/[id] — observacoes", () => {
  it("agent grava; o texto chega com trim", async () => {
    const r = await PATCH(patchReq({ observacoes: `  ${SEGREDO}  ` }), ctx);
    expect(r.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
    expect(enviado?.observacoes).toBe(SEGREDO);
    expect((await r.json()).data.observacoes).toBe(SEGREDO);
  });

  it("vazio (ou só espaço) apaga: vai null para o banco", async () => {
    const r = await PATCH(patchReq({ observacoes: "   " }), ctx);
    expect(r.status).toBe(200);
    expect(enviado).toHaveProperty("observacoes", null);
  });

  it("acima de 4000 caracteres é 422 e não toca o banco", async () => {
    const r = await PATCH(patchReq({ observacoes: "a".repeat(4001) }), ctx);
    expect(r.status).toBe(422);
    expect(enviado).toBeNull();
  });

  it("audit e evento dizem QUE mudou, nunca o texto", async () => {
    await PATCH(patchReq({ observacoes: SEGREDO }), ctx);
    // Controle positivo: o audit foi chamado e nomeia o campo.
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]?.[0];
    expect(entrada?.metadata?.fields).toEqual(["observacoes"]);
    expect(JSON.stringify(entrada)).not.toContain(SEGREDO);
    expect(eventos.length).toBeGreaterThan(0);
    expect(JSON.stringify(eventos)).not.toContain(SEGREDO);
  });

  it("papel abaixo de agent (viewer) é recusado antes de qualquer escrita", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    const r = await PATCH(patchReq({ observacoes: SEGREDO }), ctx);
    expect(r.status).toBe(403);
    expect(enviado).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte em modo somente leitura é barrado antes do papel e do banco", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USUARIO,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as never);
    const r = await PATCH(patchReq({ observacoes: SEGREDO }), ctx);
    expect(r.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/contacts/[id] — a ficha traz observacoes", () => {
  it("pede a coluna e a devolve", async () => {
    estado = { ...estado, observacoes: SEGREDO, cpf_hash: null };
    const r = await GET(new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}`), ctx);
    expect(r.status).toBe(200);
    expect(colunasPedidas.some((c) => /\bobservacoes\b/.test(c))).toBe(true);
    expect((await r.json()).data.observacoes).toBe(SEGREDO);
  });
});
