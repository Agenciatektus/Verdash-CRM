import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({
  user: true,
  role: "agent" as string,
  contact: { organization_id: "org-a", is_anonymized: false } as {
    organization_id: string;
    is_anonymized: boolean;
  } | null,
  error: null as unknown,
  candidate: null as unknown,
  filters: [] as unknown[][],
  admin: vi.fn(),
  min: null as string | null,
}));
vi.mock("@/lib/auth/require-role", () => ({
  // A rota exige PAPEL (`viewer`+, enriquecimento so `agent`+), e nao apenas sessao: ela devolve o
  // enriquecimento de prospeccao, que o banco esconde de `authenticated` de
  // proposito. Este mock respeita `state.user` para o caso de 401 continuar
  // sendo exercido de verdade, e fixa a organizacao ATIVA em `org-a` — que e o
  // ponto do conserto: a organizacao vem da sessao, nunca da linha do contato.
  requireRole: async (min: string) => {
    state.min = min;
    return state.user
      ? { ok: true as const, user: { id: "user-a" }, org: { orgId: "org-a", role: state.role } }
      : {
          ok: false as const,
          response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user ? { id: "user-a" } : null }, error: null }),
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "limit", "is", "not"]) q[name] = () => q;
      q.maybeSingle = async () => ({ data: state.contact, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "contacts" ? state.contact : [], error: null }).then(
          resolve,
        );
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.admin();
    const q: Record<string, unknown> = {};
    for (const name of ["select", "order", "limit"]) q[name] = () => q;
    q.eq = (...args: unknown[]) => {
      state.filters.push(args);
      return q;
    };
    q.maybeSingle = async () => ({ data: state.candidate, error: state.error });
    return { from: () => q };
  },
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));
import { GET } from "@/app/api/v1/contacts/[id]/crm-summary/route";
const prospect = {
  name: "Clínica exemplo",
  category: "Estética",
  address: null,
  website: "https://example.com",
  maps_url: null,
  rating: 4.9,
  reviews: 100,
  emails: [],
  socials: [],
};
const run = () =>
  GET(new NextRequest("https://crm.example/api/v1/contacts/contact-a/crm-summary"), {
    params: Promise.resolve({ id: "contact-a" }),
  });
beforeEach(() => {
  state.user = true;
  state.role = "agent";
  state.contact = { organization_id: "org-a", is_anonymized: false };
  state.candidate = {
    data: { ...prospect, secret_raw: "must not leave server" },
    created_at: "2026-09-16T10:00:00Z",
  };
  state.error = null;
  state.filters = [];
  state.admin.mockClear();
});
describe("enriquecimento autorizado no resumo CRM", () => {
  it("filtra contato e organização autorizados e projeta apenas os campos públicos", async () => {
    const r = await run();
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(state.filters).toEqual([
      ["organization_id", "org-a"],
      ["contact_id", "contact-a"],
    ]);
    expect(body.data.enrichment.name).toBe(prospect.name);
    expect(body.data.enrichment.secret_raw).toBeUndefined();
  });
  it("não consulta service role quando RLS nega o contato", async () => {
    state.contact = null;
    expect((await run()).status).toBe(404);
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("requer autenticação", async () => {
    state.user = false;
    expect((await run()).status).toBe(401);
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("viewer (e o acompanhamento somente leitura) lê o resumo, mas nunca o enriquecimento", async () => {
    state.role = "viewer";
    state.candidate = { data: { name: "Prospect" }, created_at: "2026-01-01T00:00:00Z" };
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enrichment).toBeNull();
    expect(body.data.leads).toEqual([]);
    // Controle: o service role nem é aberto para quem está abaixo de `agent`.
    expect(state.admin).not.toHaveBeenCalled();
    // A porta da rota é `viewer`: voltar para `agent` derruba o painel em modo leitura.
    expect(state.min).toBe("viewer");
  });
  it("não recupera enriquecimento de contato anonimizado", async () => {
    state.contact!.is_anonymized = true;
    const body = await (await run()).json();
    expect(body.data.enrichment).toBeNull();
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("separa ausência de falha sem derrubar as demais seções", async () => {
    state.candidate = null;
    expect((await (await run()).json()).data.enrichment_error).toBe(false);
    state.error = { message: "DB unavailable" };
    const body = await (await run()).json();
    expect(body.data.enrichment_error).toBe(true);
    expect(body.data.leads).toEqual([]);
  });
});
