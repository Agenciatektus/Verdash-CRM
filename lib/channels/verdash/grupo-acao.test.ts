import { afterEach, describe, expect, it, vi } from "vitest";

import { montarChamada } from "@/lib/grupos/acoes";

import { verdashGrupoAcao } from "./client";

const G = "120363025407046714@g.us";
const base = { instanceName: "i", token: "tok-da-instancia-tok-da-instancia-12", baseUrl: "https://fzap.test" };

afterEach(() => vi.unstubAllGlobals());

describe("verdashGrupoAcao", () => {
  it("pareado: chama a edge com x-crm-token, nunca o FZAP", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { ok: true } })));
    vi.stubGlobal("fetch", f);
    const entrada = { acao: "sair", groupChatId: G };
    expect(await verdashGrupoAcao({ ...base, vinculoId: "v" }, entrada, montarChamada(entrada) as never)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/crm-grupo-acao$/);
    expect((init.headers as Record<string, string>)["x-crm-token"]).toBe(base.token);
  });
  it("pareado: recusa da edge vira erro tipado com motivo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "whatsapp_recusou", motivo: "not admin" }), { status: 422 })));
    const entrada = { acao: "sair", groupChatId: G };
    await expect(verdashGrupoAcao({ ...base, vinculoId: "v" }, entrada, montarChamada(entrada) as never)).rejects.toMatchObject({ code: "whatsapp_recusou", motivo: "not admin" });
  });
  it("direto: fala com o FZAP usando o token da instância", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { inviteLink: "https://chat.whatsapp.com/x" } })));
    vi.stubGlobal("fetch", f);
    const entrada = { acao: "link", groupChatId: G };
    expect(await verdashGrupoAcao({ ...base, vinculoId: null }, entrada, montarChamada(entrada) as never)).toEqual({ link: "https://chat.whatsapp.com/x" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://fzap.test/group/invitelink");
    expect((init.headers as Record<string, string>).token).toBe(base.token);
  });
});
