import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ligada: true,
  segredo: "whsec_teste" as string | null,
  sinal: { eventoId: "evt_1", tipo: "invoice.paid", clienteRef: "cus_1" } as { eventoId: string; tipo: string; clienteRef: string | null; cobrancaRef?: string | null } | null,
  permitido: true,
  baldes: [] as string[],
  aviso: vi.fn(),
  processar: vi.fn(),
  efeitos: vi.fn(() => ({ aoCriar: () => undefined, aoDuplicar: () => undefined })),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/cobranca/configuracao", () => ({ segredoDoWebhook: async () => h.segredo }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: () => ({ verificarWebhook: () => h.sinal }) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string) => {
    h.baldes.push(balde);
    return { allowed: h.permitido };
  },
}));
vi.mock("@/lib/cobranca/compra", () => ({ processarCompra: h.processar }));
vi.mock("@/lib/cobranca/compra-efeitos", () => ({ efeitosDaCompra: h.efeitos }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

const ORG = "cccccccc-0000-4000-8000-000000000001";

interface Mundo {
  duplicado: boolean;
  statusExistente: string;
  dona: { organization_id: string } | null;
  donaDaCobranca: { organization_id: string } | null;
  emit: Resposta;
  flag: string | null;
  compra: Resposta;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "webhook_events_log") {
    const op = operacao(c);
    if (op === "insert") return m.duplicado ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1", status: "received" } };
    if (op === "select") return { data: { id: "linha-1", status: m.statusExistente } };
    return { data: null };
  }
  if (c.tabela === "cobranca_assinaturas") return { data: m.dona };
  if (c.tabela === "cobranca_pagamentos") return { data: m.donaDaCobranca };
  if (c.tabela === "platform_config") return { data: m.flag === null ? null : { valor: m.flag } };
  if (c.tabela === "cobranca_compras") return m.compra;
  return {};
}

const pedido = (provedor = "stripe", corpo = '{"id":"evt_1"}', ip: string | null = "10.0.0.1") =>
  POST(
    new NextRequest(`http://localhost/api/v1/webhooks/cobranca/${provedor}`, {
      method: "POST",
      body: corpo,
      headers: { "stripe-signature": "t=1,v1=ab", ...(ip ? { "x-forwarded-for": ip } : {}) },
    }),
    { params: Promise.resolve({ provedor }) },
  );
const doLog = (op: string) => h.banco.cadeias.filter((c) => c.tabela === "webhook_events_log" && operacao(c) === op);
const emits = () => h.banco.rpcs.filter((r) => r.nome === "emit_event");
const TOKEN_ASAAS = ["token", "do", "aviso", "0123456789abcdef"].join("_");
const doAsaas = (headers: Record<string, string>) =>
  POST(
    new NextRequest("http://localhost/api/v1/webhooks/cobranca/asaas", { method: "POST", body: '{"id":"evt_1"}', headers }),
    { params: Promise.resolve({ provedor: "asaas" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.processar.mockResolvedValue({ tipo: "criada", org: "org-x" });
  h.ligada = true;
  h.segredo = "whsec_teste";
  h.sinal = { eventoId: "evt_1", tipo: "invoice.paid", clienteRef: "cus_1" };
  h.permitido = true;
  h.baldes = [];
  m = { duplicado: false, statusExistente: "received", dona: { organization_id: ORG }, donaDaCobranca: null, emit: { data: "ev-1" }, flag: null, compra: { data: [{ id: "compra-1" }] } };
  h.banco = bancoFalso(responder, () => m.emit);
});

describe("webhook da cobrança", () => {
  it("provedor fora da lista, chave desligada ou sem segredo: 404 e nada gravado", async () => {
    expect((await pedido("mercadopago")).status).toBe(404);
    h.ligada = false;
    expect((await pedido()).status).toBe(404);
    h.ligada = true;
    h.segredo = null;
    expect((await pedido()).status).toBe(404);
    expect(h.banco.cadeias.filter((c) => c.tabela === "webhook_events_log")).toEqual([]);
  });

  it("⭐ assinatura inválida: 401 e deixa RASTRO que o dono vê (linha valid_signature=false, sem org, sem id, sem cabeçalhos)", async () => {
    h.sinal = null;
    expect((await pedido()).status).toBe(401);
    expect(doLog("insert").map((c) => argumentos(c, "insert")?.[0])).toEqual([
      {
        organization_id: null, provider: "stripe", raw_body: "{}", headers: null, signature_header: null,
        valid_signature: false, external_id: null, status: "error", error_message: "assinatura_invalida",
      },
    ]);
    expect(h.aviso).toHaveBeenCalledWith("cobranca.webhook_recusado", { provedor: "stripe", motivo: "assinatura_invalida" });
    expect(emits()).toEqual([]);
  });

  it("⭐ válido: ponteiro sem org, sem cabeçalhos e com corpo {id,type}; emite o sinal e fecha a linha", async () => {
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(argumentos(doLog("insert")[0]!, "insert")?.[0]).toEqual({
      organization_id: null, provider: "stripe", raw_body: '{"id":"evt_1","type":"invoice.paid"}', headers: null,
      signature_header: "t=1,v1=ab", valid_signature: true, external_id: "evt_1", event_type: "invoice.paid", status: "received",
    });
    expect(emits()[0]?.args).toEqual({
      p_event_type: "cobranca.sinal", p_entity_kind: "organization", p_entity_id: ORG,
      p_payload: { provedor: "stripe", evento_id: "evt_1", tipo: "invoice.paid" }, p_metadata: { origem: "webhook_cobranca" }, p_organization_id: ORG,
    });
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
  });

  it("⭐ duplicado já processado: 200 sem emitir", async () => {
    m.duplicado = true;
    m.statusExistente = "processed";
    expect((await pedido()).status).toBe(200);
    expect(emits()).toEqual([]);
  });

  it("⭐ duplicado ainda received (o emit anterior falhou): emite de novo e fecha a linha", async () => {
    m.duplicado = true;
    expect((await pedido()).status).toBe(200);
    expect(emits()).toHaveLength(1);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
  });

  it("cliente desconhecido: linha error com o motivo, 200 e nenhum sinal (a reconciliação cura)", async () => {
    m.dona = null;
    expect((await pedido()).status).toBe(200);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
    expect(emits()).toEqual([]);
  });

  it("emit que falha: 503 e a linha fica received (o provedor reentrega)", async () => {
    m.emit = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await pedido()).status).toBe(503);
    expect(doLog("update")).toEqual([]);
  });

  it("⭐ aviso VÁLIDO nunca recebe 429, mesmo com o balde de recusas cheio (a reativação de quem pagou não espera)", async () => {
    h.permitido = false;
    expect((await pedido()).status).toBe(200);
    expect(h.baldes).toEqual([]);
  });

  it("assinatura inválida acima de 120/min do mesmo IP: 429 e nenhuma linha", async () => {
    h.sinal = null;
    h.permitido = false;
    expect((await pedido()).status).toBe(429);
    expect(h.baldes).toEqual(["cobranca-webhook-recusado:10.0.0.1"]);
    expect(doLog("insert")).toEqual([]);
  });

  it("recusa sem proxy à frente conta num balde próprio de recusas (só recusas o dividem)", async () => {
    h.sinal = null;
    await pedido("stripe", '{"id":"evt_1"}', null);
    expect(h.baldes).toEqual(["cobranca-webhook-recusado:sem-proxy"]);
  });

  it("corpo acima de 1 MB: 413", async () => {
    expect((await pedido("stripe", "x".repeat(1_048_577))).status).toBe(413);
    expect(doLog("insert")).toEqual([]);
  });
});

describe("webhook da cobrança pelo Asaas (PR 3b)", () => {
  it("⭐ Asaas: o token do cabeçalho nunca é gravado — nem como assinatura, que só a Stripe tem", async () => {
    const res = await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "stripe-signature": "t=1,v1=forjada" });
    expect(res.status).toBe(200);
    expect(argumentos(doLog("insert")[0]!, "insert")?.[0]).toMatchObject({ provider: "asaas", signature_header: null, headers: null });
    expect(JSON.stringify([h.banco.cadeias, h.banco.rpcs])).not.toContain(TOKEN_ASAAS);
  });

  it("Asaas com token errado: 401, a linha de recusa sem token e sem assinatura", async () => {
    h.sinal = null;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "stripe-signature": "t=1,v1=forjada" })).status).toBe(401);
    expect(argumentos(doLog("insert")[0]!, "insert")?.[0]).toMatchObject({ provider: "asaas", signature_header: null, valid_signature: false });
    expect(JSON.stringify(h.banco.cadeias)).not.toContain(TOKEN_ASAAS);
  });

  it("⭐ token vazado inundando com clientes que não existem: acima do balde, 200 SEM gravar linha (429 pararia a fila do Asaas)", async () => {
    m.dona = null;
    h.permitido = false;
    const res = await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "x-forwarded-for": "10.0.0.9" });
    expect(res.status).toBe(200);
    // Trocar o x-forwarded-for não troca o balde: a chave é global por provedor.
    await doAsaas({ "asaas-access-token": TOKEN_ASAAS, "x-forwarded-for": "10.0.0.10" });
    expect(h.baldes).toEqual(["cobranca-webhook-desconhecido:asaas", "cobranca-webhook-desconhecido:asaas"]);
    expect(doLog("insert")).toEqual([]);
  });

  it("abaixo do balde, o aviso de cliente desconhecido do Asaas segue gravado como antes (a reconciliação cura)", async () => {
    m.dona = null;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS })).status).toBe(200);
    expect(doLog("insert")).toHaveLength(1);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
  });

  it("controle: aviso VÁLIDO de cliente conhecido do Asaas nunca passa por balde nenhum", async () => {
    h.permitido = false;
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS })).status).toBe(200);
    expect(h.baldes).toEqual([]);
  });
});

describe("venda direta: compra da LP de cliente desconhecido (fatia 2)", () => {
  const compras = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_compras");
  const flagLida = () => h.banco.cadeias.filter((c) => c.tabela === "platform_config");
  const checkout = (id: string, clienteRef = "cus_novo") => {
    h.sinal = { eventoId: id, tipo: "checkout.session.completed", clienteRef };
  };

  it("(a) flag desligada: mesma resposta e mesmos writes de antes, nenhuma linha de compra", async () => {
    checkout("evt_a_desligada");
    m.dona = null;
    m.flag = "desligado";
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("cliente_desconhecido");
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
    expect(compras()).toEqual([]);
    expect(emits()).toEqual([]);
  });

  it("(a) flag ausente: igual a desligada", async () => {
    checkout("evt_a_ausente");
    m.dona = null;
    m.flag = null;
    expect((await pedido()).status).toBe(200);
    expect(compras()).toEqual([]);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
  });

  it("(a) a flag nem é lida para outro tipo de evento, nem para cliente conhecido", async () => {
    h.sinal = { eventoId: "evt_a_outro_tipo", tipo: "invoice.paid", clienteRef: "cus_novo" };
    m.dona = null;
    m.flag = "ligado";
    await pedido();
    checkout("evt_a_conhecido", "cus_1");
    m.dona = { organization_id: ORG };
    await pedido();
    expect(flagLida()).toEqual([]);
    expect(compras()).toEqual([]);
  });

  it("(d) flag ligada: chama processarCompra com o id da linha gravada e responde 200", async () => {
    checkout("evt_d_liga");
    m.dona = null;
    m.flag = "ligado";
    m.compra = { data: [{ id: "compra-d-111" }] };
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(h.processar).toHaveBeenCalledTimes(1);
    expect(h.processar.mock.calls[0]?.[1]).toBe("compra-d-111");
    expect(h.efeitos).toHaveBeenCalledWith(h.banco.cliente);
    expect(h.processar.mock.calls[0]?.[2]).toBe(h.efeitos.mock.results[0]?.value);
    expect(h.processar.mock.calls[0]?.[2]).toHaveProperty("aoCriar");
  });

  it("(d) reentrega (conflito ignorado, sem linha devolvida): relê o id pelo evento e processa", async () => {
    checkout("evt_d_reentrega");
    m.dona = null;
    m.flag = "ligado";
    m.compra = { data: [] };
    h.banco = bancoFalso((c) => (c.tabela === "cobranca_compras" && operacao(c) === "select" ? { data: { id: "compra-d-222" } } : c.tabela === "cobranca_compras" ? { data: [] } : responder(c)), () => m.emit);
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(h.processar.mock.calls[0]?.[1]).toBe("compra-d-222");
  });

  it("(d) processarCompra lançando: 200 {compra:registrada} do mesmo jeito", async () => {
    checkout("evt_d_lanca");
    m.dona = null;
    m.flag = "ligado";
    h.processar.mockRejectedValue(new Error("stripe fora"));
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { compra: "registrada" } });
  });

  it("(d) flag desligada: processarCompra nunca é chamado", async () => {
    checkout("evt_d_desligada");
    m.dona = null;
    m.flag = "desligado";
    await pedido();
    expect(h.processar).not.toHaveBeenCalled();
  });

  it("(b) flag ligada + checkout.session.completed desconhecido: 1 linha recebida com o id do ponteiro, 200, ponteiro fechado", async () => {
    checkout("evt_b_unico");
    m.dona = null;
    m.flag = "ligado";
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(compras()).toHaveLength(1);
    expect(argumentos(compras()[0]!, "upsert")).toEqual([
      { provedor: "stripe", evento_id: "evt_b_unico", status: "recebida" },
      { onConflict: "evento_id", ignoreDuplicates: true },
    ]);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "processed" });
    expect(JSON.stringify(h.banco.cadeias)).not.toContain("cliente_desconhecido");
    expect(emits()).toEqual([]);
  });

  it("(c) reentrega com o ponteiro já processado: 200 e nenhuma segunda compra", async () => {
    checkout("evt_c_reentrega");
    m.dona = null;
    m.flag = "ligado";
    await pedido();
    m.duplicado = true;
    m.statusExistente = "processed";
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(compras()).toHaveLength(1);
  });

  it("(c) reentrega com o ponteiro ainda received: o upsert ignora o conflito (ignoreDuplicates) e responde 200", async () => {
    checkout("evt_c_received");
    m.dona = null;
    m.flag = "ligado";
    m.duplicado = true;
    m.statusExistente = "received";
    const res = await pedido();
    expect(res.status).toBe(200);
    expect(argumentos(compras()[0]!, "upsert")?.[1]).toEqual({ onConflict: "evento_id", ignoreDuplicates: true });
  });

  it("falha ao gravar a compra: 503 e o ponteiro fica received (a Stripe reentrega)", async () => {
    checkout("evt_falha_compra");
    m.dona = null;
    m.flag = "ligado";
    m.compra = { error: { code: "XX000", message: "boom" } };
    expect((await pedido()).status).toBe(503);
    expect(doLog("update")).toEqual([]);
  });

  it("(d) flag ligada, mas outro tipo de evento da Stripe: caminho antigo", async () => {
    h.sinal = { eventoId: "evt_d_outro", tipo: "customer.subscription.deleted", clienteRef: "cus_novo" };
    m.dona = null;
    m.flag = "ligado";
    expect((await pedido()).status).toBe(200);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
    expect(compras()).toEqual([]);
    expect(flagLida()).toEqual([]);
  });

  it("(d) flag ligada, provedor asaas com o mesmo tipo: caminho antigo", async () => {
    checkout("evt_d_asaas");
    m.dona = null;
    m.flag = "ligado";
    expect((await doAsaas({ "asaas-access-token": TOKEN_ASAAS })).status).toBe(200);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
    expect(compras()).toEqual([]);
    expect(flagLida()).toEqual([]);
  });
});

describe("webhook da cobrança: disputa da Stripe (sem customer, só a cobrança)", () => {
  const disputa = () => ({ eventoId: "evt_dp", tipo: "charge.dispute.created", clienteRef: null, cobrancaRef: "ch_1" });
  const consultas = (tabela: string) => h.banco.cadeias.filter((c) => c.tabela === tabela);

  it("acha a org pela cobrança já gravada no histórico e emite o sinal", async () => {
    h.sinal = disputa();
    m.donaDaCobranca = { organization_id: ORG };
    expect((await pedido()).status).toBe(200);
    expect(emits()).toHaveLength(1);
    expect(emits()[0]?.args).toMatchObject({ p_organization_id: ORG, p_entity_id: ORG });
    const c = consultas("cobranca_pagamentos")[0]!;
    expect(c.passos.filter((p) => p.metodo === "eq").map((p) => p.args)).toEqual([["provedor", "stripe"], ["cobranca_ref", "ch_1"]]);
    expect(consultas("cobranca_assinaturas")).toEqual([]);
  });

  it("controle: cobrança que ninguém tem no histórico continua cliente_desconhecido, sem sinal", async () => {
    h.sinal = disputa();
    expect((await pedido()).status).toBe(200);
    expect(emits()).toEqual([]);
    expect(argumentos(doLog("update")[0]!, "update")?.[0]).toMatchObject({ status: "error", error_message: "cliente_desconhecido" });
  });

  it("com clienteRef, o histórico nem é consultado", async () => {
    expect((await pedido()).status).toBe(200);
    expect(consultas("cobranca_pagamentos")).toEqual([]);
  });
});
