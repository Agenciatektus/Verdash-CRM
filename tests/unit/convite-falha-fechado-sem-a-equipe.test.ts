/**
 * POST /api/v1/team/invite × leitura da equipe que falha (PR #459, P2-1 do cassio-secrev).
 *
 * O "já é membro" sai dos e-mails que `nomesDeMembros` devolve numa chamada só. Se
 * essa chamada falha, o mapa vem vazio — e, sem a trava, o convite seria reenviado
 * para quem já é membro. A rota tem de recusar (503) antes de emitir qualquer convite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitirConvite = vi.fn();
const issueInvite = vi.fn();
const nomesDeMembros = vi.fn();

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u-admin", email: "admin@x.com", full_name: "Admin", idioma: "pt-BR" },
    org: { orgId: "org-1" },
  }),
}));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true }));
vi.mock("@/lib/cobranca/limites", () => ({
  lerLimiteDoPlano: async () => null,
  mensagemDoLimite: () => "",
}));
vi.mock("@/lib/team/convites", () => ({ emitirConvite }));
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite }));
vi.mock("@/lib/users/nomes-de-membros", () => ({ nomesDeMembros }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: async () => ({
            data: [{ user_id: "u-ana", provisional_until_handover: null }],
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

async function convidar(email: string) {
  const { POST } = await import("@/app/api/v1/team/invite/route");
  const req = new Request("http://localhost/api/v1/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitations: [{ email, role: "agent" }] }),
  });
  return POST(req as never);
}

describe("convite × leitura da equipe", () => {
  beforeEach(() => {
    emitirConvite.mockReset();
    issueInvite.mockReset();
    nomesDeMembros.mockReset();
  });

  it("leitura falhou (mapa vazio com membros ativos): 503 e nenhum convite emitido", async () => {
    nomesDeMembros.mockResolvedValue(new Map());
    const res = await convidar("ana@x.com");
    expect(res.status).toBe(503);
    expect(emitirConvite).not.toHaveBeenCalled();
    expect(issueInvite).not.toHaveBeenCalled();
  });

  it("leitura ok: quem já é membro não recebe convite de novo", async () => {
    nomesDeMembros.mockResolvedValue(
      new Map([["u-ana", { full_name: "Ana", email: "Ana@X.com", last_sign_in_at: null }]]),
    );
    const res = await convidar("ana@x.com");
    expect(res.status).not.toBe(503);
    expect(emitirConvite).not.toHaveBeenCalled();
    expect(issueInvite).not.toHaveBeenCalled();
  });
});
