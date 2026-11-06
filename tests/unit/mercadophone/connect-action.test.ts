import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", support: null }),
  resolveActiveOrg: async () => ({ orgId: "o1", role: "admin" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: "cifrado", error: null }),
    from: () => ({ upsert: (...a: unknown[]) => (upsert(...a), { select: () => ({ single: async () => ({ data: { id: "i1" }, error: null }) }) }) }),
  }),
}));

import { connectMercadoPhone } from "@/app/actions/integrations/connectMercadoPhone";

beforeEach(() => upsert.mockClear());

describe("connectMercadoPhone", () => {
  it("recusa token inválido (401) sem gravar nada", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    expect(await connectMercadoPhone({ apiToken: "ruim", webhookToken: "w" })).toEqual({ ok: false, error: "invalid_token" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("recusa campo vazio", async () => {
    expect(await connectMercadoPhone({ apiToken: "", webhookToken: "w" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("token válido grava provider mercadophone, healthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { totalItens: 0, itens: [] } }), { status: 200 })));
    expect(await connectMercadoPhone({ apiToken: "bom", webhookToken: "w" })).toEqual({ ok: true });
    expect(upsert.mock.calls[0]![0]).toMatchObject({ provider: "mercadophone", status: "healthy", organization_id: "o1" });
  });
});
