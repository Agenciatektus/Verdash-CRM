import { beforeEach, describe, expect, it, vi } from "vitest";

const credenciais = vi.hoisted(() => vi.fn());
const listar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mercadophone/credenciais", () => ({ credenciaisMercadoPhone: credenciais }));
vi.mock("@/lib/mercadophone/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/mercadophone/api-client")>()),
  listarEstoque: listar,
}));
vi.mock("@/lib/ai/rag/debounce", () => ({ getRedis: () => null }));

import { agruparEstoque, crmCheckPdvStock, filtrarGrupos } from "@/lib/mcp/tools/estoque-pdv";
import type { McpContext } from "@/lib/mcp/types";

const TOKEN = "token-secreto-pdv";
const ctx = { organizationId: "22222222-2222-4222-8222-222222222222" } as unknown as McpContext;

// O dublê TEM valorCusto e lucro: o controle negativo da ausência no retorno.
const linha = (over: Record<string, unknown> = {}) => ({
  aparelhoDescricao: "iPhone 13",
  gbDescricao: "128GB",
  corDescricao: "Preto",
  estadoProdutoDescricao: "Seminovo",
  tipoProdutoDescricao: "Aparelho",
  disponibilidade: "Disponível para venda",
  produtoDisponibilidadeId: 1,
  valorVenda: "3200.00",
  valorCusto: "2100.00",
  quantidade: 1,
  serialNumber: "SERIE123",
  ...over,
});

beforeEach(() => {
  credenciais.mockReset().mockResolvedValue({ apiToken: TOKEN });
  listar.mockReset();
});

describe("agruparEstoque", () => {
  it("agrupa aparelhos iguais, conta e esconde o que não está disponível", () => {
    const { grupos: g } = agruparEstoque([
      linha(),
      linha({ serialNumber: "B" }),
      linha({ corDescricao: "Azul" }),
      linha({ disponibilidade: "Laboratório", produtoDisponibilidadeId: 2 }),
      linha({ aparelhoDescricao: "", nome: "Capa", tipoProdutoDescricao: "Acessório", gbDescricao: "" }),
    ]);
    expect(g).toHaveLength(3);
    expect(g.find((x) => x.cor === "Preto" && x.aparelho === "iPhone 13")?.quantidade).toBe(2);
    expect(g.find((x) => x.tipo === "Acessório")?.aparelho).toBe("Capa");
  });

  it("sem aparelhoDescricao: nome com IMEI/série é pulado e contado; nome limpo entra", () => {
    const imei = "356789012345678";
    const { grupos, semNome } = agruparEstoque([
      linha({ aparelhoDescricao: "", nome: `4847227 - REDMI PAD 2 - SN: ${imei}` }),
      linha({ aparelhoDescricao: "", nome: `Celular ${imei}` }),
      linha({ aparelhoDescricao: "", nome: "Capa", descricao: `${imei} - X` }),
    ]);
    expect(semNome).toBe(2);
    expect(JSON.stringify(grupos)).not.toContain(imei);
    expect(grupos.map((g) => g.aparelho)).toEqual(["Capa"]);
  });

  it("filtra por texto sem acento nem caixa", () => {
    const { grupos: g } = agruparEstoque([linha(), linha({ aparelhoDescricao: "Galaxy S22" })]);
    expect(filtrarGrupos(g, "IPHONE 128gb")).toHaveLength(1);
    expect(filtrarGrupos(g, "xiaomi")).toHaveLength(0);
  });
});

describe("crm_check_pdv_stock", () => {
  it("pagina, nunca devolve custo, série nem token", async () => {
    listar
      .mockResolvedValueOnce({ totalItens: 201, itens: Array.from({ length: 200 }, () => linha()) })
      .mockResolvedValueOnce({ totalItens: 201, itens: [linha({ corDescricao: "Azul" })] });
    const r = await crmCheckPdvStock.handler({ termo: "iphone" }, ctx);
    expect(listar).toHaveBeenCalledTimes(2);
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/valorCusto|2100|SERIE123|serialNumber/);
    expect(json).not.toContain(TOKEN);
    expect((r as { itens: Array<{ quantidade: number }> }).itens.map((i) => i.quantidade).sort()).toEqual([1, 200]);
  });

  it("prazo da varredura estoura: devolve o parcial com aviso e não cacheia", async () => {
    const agora = vi.spyOn(Date, "now");
    let t = 0;
    agora.mockImplementation(() => (t += 15_000));
    listar.mockResolvedValue({ totalItens: 999, itens: Array.from({ length: 200 }, () => linha()) });
    const r = (await crmCheckPdvStock.handler({}, ctx)) as { parcial?: boolean; itens: unknown[] };
    agora.mockRestore();
    expect(r.parcial).toBe(true);
    expect(r.itens.length).toBeGreaterThan(0);
    expect(listar.mock.calls.length).toBeLessThan(25);
  });

  it("org sem conexão não chama a API", async () => {
    credenciais.mockResolvedValue(null);
    const r = (await crmCheckPdvStock.handler({}, ctx)) as { motivo: string };
    expect(r.motivo).toBe("pdv_nao_conectado");
    expect(listar).not.toHaveBeenCalled();
  });

  it("API fora devolve só o código, sem token", async () => {
    const { MercadoPhoneApiError } = await import("@/lib/mercadophone/api-client");
    listar.mockRejectedValue(new MercadoPhoneApiError(0, "timeout"));
    const r = (await crmCheckPdvStock.handler({}, ctx)) as { motivo: string };
    expect(r.motivo).toBe("pdv_nao_respondeu");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
