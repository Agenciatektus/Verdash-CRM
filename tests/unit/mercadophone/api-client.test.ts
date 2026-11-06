import { afterEach, describe, expect, it, vi } from "vitest";
import { buscarCliente, listarEstoque, listarVendas, MercadoPhoneApiError } from "@/lib/mercadophone/api-client";

const TOKEN = "tok-secreto-123";
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("api-client do MercadoPhone", () => {
  it("manda Authorization sem Bearer, a classe/método na URL e o corpo JSON", async () => {
    const f = vi.fn().mockResolvedValue(ok({ totalItens: 0, itens: [] }));
    vi.stubGlobal("fetch", f);
    await listarEstoque(TOKEN, { page: 2, limit: 5 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://app.mercadophone.tech/api.php?class=EstoqueApiController&method=index");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ page: 2, limit: 5, filters: {} });
  });

  it("listarVendas leva o período em filters", async () => {
    const f = vi.fn().mockResolvedValue(ok({ totalItens: 0, itens: [] }));
    vi.stubGlobal("fetch", f);
    await listarVendas(TOKEN, { dataVendaInicial: "2026-11-01", dataVendaFinal: "2026-11-06" });
    expect(f.mock.calls[0][0]).toContain("class=VendaApiController&method=index");
    expect(JSON.parse(f.mock.calls[0][1].body).filters).toEqual({
      dataVendaInicial: "2026-11-01",
      dataVendaFinal: "2026-11-06",
    });
  });

  it("buscarCliente: 404 vira null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    expect(await buscarCliente(TOKEN, 9)).toBeNull();
  });

  it("401 vira erro tipado e o token não aparece na mensagem", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const err = await listarEstoque(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(MercadoPhoneApiError);
    expect(err.code).toBe("unauthorized");
    expect(JSON.stringify(err) + err.message + err.stack).not.toContain(TOKEN);
  });

  it("falha de rede não vaza a mensagem do fetch (que pode ter o token)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`)));
    const err = await listarEstoque(TOKEN).catch((e) => e);
    expect(err.code).toBe("network_error");
    expect(err.message).not.toContain(TOKEN);
  });
});
