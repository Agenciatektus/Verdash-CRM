import { describe, expect, it } from "vitest";
import amostras from "../../fixtures/mercadophone/amostras.json";
import { arquivoSemPii } from "@/lib/mercadophone/arquivo-webhook";

// Valores-sentinela no formato real da venda (VendaApiController): nome, texto livre e cliente.
const vendaComPii = (): Record<string, unknown> => ({
  ...(structuredClone(amostras.venda_VendaApiController) as Record<string, unknown>),
  clienteNome: "FULANO SENTINELA",
  observacao: "cpf 123.456.789-00 tel 91988887777",
  cliente: { nome: "BELTRANO SENTINELA", telefone: "(91) 99999-0000" },
});
const VAZAMENTOS = ["SENTINELA", "123.456.789", "91988887777", "99999-0000"];

describe("arquivoSemPii (log do webhook MercadoPhone)", () => {
  it.each([
    ["venda dentro de `dados`", (v: Record<string, unknown>) => ({ tipoEvento: "venda_salva", dados: v })],
    ["venda solta no corpo", (v: Record<string, unknown>) => ({ tipoEvento: "venda_salva", ...v })],
  ])("%s: nenhum valor de cliente chega ao arquivo", (_nome, montar) => {
    const venda = vendaComPii();
    const body = montar(venda) as Record<string, unknown>;
    const alvo = (body.dados as Record<string, unknown> | undefined) ?? body;
    const arquivo = JSON.stringify(arquivoSemPii(body, alvo, "venda_salva", String(venda.id)));
    for (const v of VAZAMENTOS) expect(arquivo).not.toContain(v);
    // Os NOMES das chaves continuam lá: é o que ajuda a descobrir o envelope real.
    expect(arquivo).toContain("clienteNome");
    expect(arquivo).toContain("observacao");
  });

  it("controle negativo: o corpo cru contém os sentinelas (o teste mede de verdade)", () => {
    const raw = JSON.stringify({ tipoEvento: "venda_salva", dados: vendaComPii() });
    for (const v of VAZAMENTOS) expect(raw).toContain(v);
  });
});
