import { describe, expect, it } from "vitest";
import amostras from "../../fixtures/mercadophone/amostras.json";
import { mapearVenda, telefoneDaVenda } from "@/lib/mercadophone/venda-mapper";
import { tokenConfere } from "@/lib/mercadophone/token-webhook";

const venda = () => structuredClone(amostras.venda_VendaApiController) as Record<string, unknown>;

describe("mapearVenda", () => {
  it("cancelada vira cancelled, total em centavos, data de Brasília em UTC", () => {
    const r = mapearVenda(venda());
    expect(r.status).toBe("cancelled");
    expect(r.total_cents).toBe(173900);
    expect(r.ordered_at).toBe("2026-11-02T14:41:00.000Z");
    expect(r.customer_external_id).toBe("10593593");
    expect(r.payment_method).toBeNull();
  });

  it("sem status de cancelamento vira delivered", () => {
    expect(mapearVenda({ ...venda(), status: "concluida" }).status).toBe("delivered");
  });

  it("payload sem custo, lucro nem dado pessoal", () => {
    const j = JSON.stringify(mapearVenda(venda()).payload);
    expect(j).not.toMatch(/valorCusto|lucro|cpf|email|telefone|\"nome\"|rua/i);
    expect(j).toContain("REDMI PAD 2");
  });

  it("sem id lança", () => {
    expect(() => mapearVenda({ ...venda(), id: undefined })).toThrow("venda_sem_id");
  });

  it("telefone sai de cliente.telefone", () => {
    expect(telefoneDaVenda(venda())).toBe("(91) 98888-7777");
  });

  it("controle negativo: campo renomeado muda o resultado", () => {
    const v = venda();
    v["total"] = v["totalVenda"];
    delete v["totalVenda"];
    expect(() => mapearVenda(v)).toThrow("total_invalido");
    const w = venda();
    const c = w["cliente"] as Record<string, unknown>;
    c["fone"] = c["telefone"];
    delete c["telefone"];
    expect(telefoneDaVenda(w)).toBeUndefined();
  });
});

describe("tokenConfere", () => {
  it("certo, errado, ausente e de outro tamanho", () => {
    expect(tokenConfere("segredo", "segredo")).toBe(true);
    expect(tokenConfere("segredo2", "segredo")).toBe(false);
    expect(tokenConfere("x", "segredo")).toBe(false);
    expect(tokenConfere(null, "segredo")).toBe(false);
    expect(tokenConfere("", "")).toBe(false);
  });
});
