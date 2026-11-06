import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ linha: null as unknown, erro: null as unknown }));
/**
 * `organizations` responde a linha do caso; o resto do layout (os funis do
 * menu, por exemplo) lê listas que aqui chegam vazias.
 */
const adminClient = {
  from: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "neq", "in", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: estado.linha, error: estado.erro });
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return q;
  },
};
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
// Os módulos liberados por empresa (9026) entram na mesma leva de consultas do
// layout; aqui não importam, e o dublê do admin só sabe ler `organizations`.
vi.mock("@/lib/organizacao/modulos-liberados", () => ({ modulosDaEmpresa: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  exigirProvaDeMfa: async () => {},
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
// `getAll` não é enfeite: o cliente da sessão (`lib/supabase/server`) lê os
// cookies por ele. Um dublê só com `get` derruba a casca — e o teste passaria
// com o erro registrado como unhandled, que é ainda pior (#3088).
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm", logoUrl: null, cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

beforeEach(() => {
  estado.linha = { onboarded_at: "2026-01-01", status: "active", settings: null };
  estado.erro = null;
});

describe("layout de /app × org parada", () => {
  it("org suspensa que nunca terminou o onboarding vai para /account-suspended, não /onboarding", async () => {
    estado.linha = { onboarded_at: null, status: "suspended", settings: null };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/account-suspended");
  });

  it("leitura de organizations que falha LANÇA em vez de renderizar a casca", async () => {
    estado.linha = null;
    estado.erro = { message: "connection reset" };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow(/organizacao_ilegivel/);
  });

  it("CONTROLE: org ativa e onboardada renderiza", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });
});
