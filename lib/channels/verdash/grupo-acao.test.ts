import { afterEach, describe, expect, it, vi } from "vitest";

import { GrupoAcaoError, montarChamada } from "@/lib/grupos/acoes";

import { erroDoFzap, verdashGrupoAcao } from "./client";

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

describe("erroDoFzap", () => {
  it("classifica o que o fzapRequest lança", () => {
    expect(erroDoFzap(new Error("verdash_request_failed: 401 invalid token xyz")).code).toBe("instancia_desconectada");
    expect(erroDoFzap(new Error("verdash_request_failed: 502 x")).code).toBe("fzap_indisponivel");
    const r = erroDoFzap(new Error("verdash_request_failed: 400 not admin"));
    expect([r.code, r.motivo]).toEqual(["whatsapp_recusou", "not admin"]);
    expect(erroDoFzap(new Error("verdash_unreachable: The operation was aborted due to timeout")).code).toBe("fzap_timeout");
    expect(erroDoFzap(new GrupoAcaoError("erro_interno")).code).toBe("erro_interno");
  });
});
