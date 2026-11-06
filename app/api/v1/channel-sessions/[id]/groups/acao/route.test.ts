import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/grupos/gestao", () => ({ criarDepsDeGestao: vi.fn(() => ({})), executarAcaoDeGrupo: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { GrupoAcaoError } from "@/lib/grupos/acoes";
import { executarAcaoDeGrupo } from "@/lib/grupos/gestao";
import { GrupoError } from "@/lib/grupos/servico";
import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const G = "120363025407046714@g.us";
const ctx = { params: Promise.resolve({ id: SESS }) };
const post = (corpo: unknown) => POST(new NextRequest("http://x", { method: "POST", body: JSON.stringify(corpo) }), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1" }, org: { orgId: ORG, role: "manager" } } as never);
});

describe("POST groups/acao", () => {
  it("info pede só viewer; as outras pedem gerente", async () => {
    vi.mocked(executarAcaoDeGrupo).mockResolvedValue({});
    await post({ group_chat_id: G, acao: "info" });
    expect(requireRole).toHaveBeenLastCalledWith("viewer", expect.anything());
    await post({ group_chat_id: G, acao: "sair" });
    expect(requireRole).toHaveBeenLastCalledWith("manager", expect.anything());
  });
  it("sem papel: 403 e o serviço não roda", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await post({ group_chat_id: G, acao: "nome", nome: "x" })).status).toBe(403);
    expect(executarAcaoDeGrupo).not.toHaveBeenCalled();
  });
  it("validação vira 400; a organização vem da sessão e não do body", async () => {
    expect((await post({ group_chat_id: G, acao: "nome", nome: " " })).status).toBe(400);
    vi.mocked(executarAcaoDeGrupo).mockResolvedValue({ ok: true });
    const res = await post({ group_chat_id: G, acao: "nome", nome: "Novo", organization_id: "outra" });
    expect(res.status).toBe(200);
    expect(executarAcaoDeGrupo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, channelSessionId: SESS, actorUserId: "u1" }));
  });
  it("grupo de outra sessão: 404", async () => {
    vi.mocked(executarAcaoDeGrupo).mockRejectedValue(new GrupoError("grupo_nao_encontrado"));
    expect((await post({ group_chat_id: G, acao: "info" })).status).toBe(404);
  });
  it("erros do WhatsApp viram mensagem em pt-BR", async () => {
    vi.mocked(executarAcaoDeGrupo).mockRejectedValue(new GrupoAcaoError("whatsapp_recusou", "not admin"));
    const res = await post({ group_chat_id: G, acao: "sair" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("O WhatsApp recusou");
    vi.mocked(executarAcaoDeGrupo).mockRejectedValue(new GrupoAcaoError("fzap_timeout"));
    expect((await post({ group_chat_id: G, acao: "sair" })).status).toBe(504);
  });
});
