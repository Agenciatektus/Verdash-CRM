import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, valorDoFiltro, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  leitura: vi.fn(),
  audit: vi.fn(),
  lerUltimaCobranca: vi.fn(),
  estornarCobranca: vi.fn(),
  limite: true,
  semEstorno: false,
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
  requirePlatformAdmin: h.leitura,
}));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: async () => true,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/cobranca/falhas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cobranca/falhas")>()),
  limiteDoProvedorPorOrg: async () => h.limite,
}));
vi.mock("@/lib/cobranca/provedores", () => ({
  adaptador: () => (h.semEstorno ? {} : { lerUltimaCobranca: h.lerUltimaCobranca, estornarCobranca: h.estornarCobranca }),
}));

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { GET, POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const url = `http://localhost/api/v1/admin/tenants/${TENANT}/assinatura/estorno`;
const visto = { cobranca_ref: "ch_1", estornado_cents_visto: 0 };
const post = (body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = () => new NextRequest(url);

let linha: Record<string, unknown> | null;
function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: { id: TENANT, status: "active", suspended_kind: null } };
  // O PostgREST recusa o embed do plano sem a dica da chave (a tabela tem 3 chaves para cobranca_planos).
  const select = String(argumentos(c, "select")?.[0] ?? "");
  if (select.includes("cobranca_planos") && !select.includes("!cobranca_assinaturas_plano_id_fkey")) {
    return { error: { code: "PGRST201", message: "more than one relationship was found" } };
  }
  return { data: linha };
}
const cobranca = (estornadoCents = 0) => ({ ref: "ch_1", valorCents: 10_000, estornadoCents, moeda: "brl", pagaEm: new Date() });

beforeEach(() => {
  vi.clearAllMocks();
  h.limite = true;
  h.semEstorno = false;
  const admin = { user: { id: h.ator }, platformAdmin: { user_id: h.ator, scope: "full", mfa_required: false } };
  h.escrita.mockResolvedValue(admin);
  h.leitura.mockResolvedValue(admin);
  h.lerUltimaCobranca.mockResolvedValue(cobranca());
  h.estornarCobranca.mockResolvedValue(undefined);
  linha = { provedor: "stripe", provedor_cliente_id: "cus_1", plano: { intervalo: "mes" } };
  h.banco = bancoFalso(responder, () => ({}));
});

describe("GET /admin/tenants/[id]/assinatura/estorno", () => {
  it("devolve a cobrança e a sugestão (até 7 dias: tudo)", async () => {
    const res = await GET(get(), ctx);
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data.cobranca).toMatchObject({ valor_cents: 10_000, estornado_cents: 0, moeda: "brl" });
    expect(corpo.data.sugestao).toEqual({ cents: 10_000, regra: "arrependimento" });
    expect(h.estornarCobranca).not.toHaveBeenCalled();
  });

  it("limite de chamadas ao provedor estourado → 429 também na leitura", async () => {
    h.limite = false;
    expect((await GET(get(), ctx)).status).toBe(429);
    expect(h.lerUltimaCobranca).not.toHaveBeenCalled();
  });

  it("sem cobrança paga → cobranca null", async () => {
    h.lerUltimaCobranca.mockResolvedValue(null);
    expect((await (await GET(get(), ctx)).json()).data).toEqual({ cobranca: null, sugestao: null });
  });

  it("provedor sem estorno → 409", async () => {
    h.semEstorno = true;
    expect((await GET(get(), ctx)).status).toBe(409);
  });
});

describe("POST /admin/tenants/[id]/assinatura/estorno", () => {
  it("estorna o valor pedido com chave de idempotência da cobrança e audita", async () => {
    const res = await POST(post({ valor_cents: 200, ...visto }), ctx);
    expect(res.status).toBe(200);
    expect(h.estornarCobranca).toHaveBeenCalledWith({ cobrancaRef: "ch_1", valorCents: 200, chaveIdempotencia: `estorno:${TENANT}:ch_1:0:200` });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.estorno_feito", metadata: expect.objectContaining({ valor_cents: 200 }) }));
  });

  it("valor acima do saldo → 422, nada estornado", async () => {
    h.lerUltimaCobranca.mockResolvedValue(cobranca(9_900));
    expect((await POST(post({ valor_cents: 200, cobranca_ref: "ch_1", estornado_cents_visto: 9_900 }), ctx)).status).toBe(422);
    expect(h.estornarCobranca).not.toHaveBeenCalled();
  });

  it("saldo mudou desde a tela (retentativa depois de timeout, outro admin) → 409, não estorna de novo", async () => {
    h.lerUltimaCobranca.mockResolvedValue(cobranca(200)); // o 1º estorno já entrou
    expect((await POST(post({ valor_cents: 200, ...visto }), ctx)).status).toBe(409);
    h.lerUltimaCobranca.mockResolvedValue({ ...cobranca(), ref: "ch_nova" }); // outra cobrança paga no meio
    expect((await POST(post({ valor_cents: 200, ...visto }), ctx)).status).toBe(409);
    expect(h.estornarCobranca).not.toHaveBeenCalled();
  });

  it("provedor sem resposta (503) → audita como incerto e manda conferir", async () => {
    h.estornarCobranca.mockRejectedValue(new ErroDoProvedor(null, "timeout", true));
    expect((await POST(post({ valor_cents: 200, ...visto }), ctx)).status).toBe(503);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.estorno_incerto" }));
  });

  it("corpo inválido → 400; sem cobrança → 409; limite → 429", async () => {
    expect((await POST(post({ valor_cents: -1, ...visto }), ctx)).status).toBe(400);
    h.lerUltimaCobranca.mockResolvedValue(null);
    expect((await POST(post({ valor_cents: 100, ...visto }), ctx)).status).toBe(409);
    h.limite = false;
    expect((await POST(post({ valor_cents: 100, ...visto }), ctx)).status).toBe(429);
  });

  it("provedor recusa → 502/503 e sem audit", async () => {
    h.estornarCobranca.mockRejectedValue(new ErroDoProvedor(400, "invalid_request_error", false));
    expect((await POST(post({ valor_cents: 100, ...visto }), ctx)).status).toBe(502);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("POST estorno: marca o pagamento em cobranca_pagamentos", () => {
  const marcas = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_pagamentos" && operacao(c) === "update");

  it("depois de estornar, grava status e valor estornado na linha da cobrança da org", async () => {
    h.lerUltimaCobranca.mockResolvedValue(cobranca(1_000));
    const res = await POST(post({ valor_cents: 2_000, cobranca_ref: "ch_1", estornado_cents_visto: 1_000 }), ctx);
    expect(res.status).toBe(200);
    expect(marcas()).toHaveLength(1);
    expect(argumentos(marcas()[0]!, "update")?.[0]).toMatchObject({ status: "estornado_parcial", valor_estornado_cents: 3_000 });
    expect(valorDoFiltro(marcas()[0]!, "eq", "organization_id")).toBe(TENANT);
    expect(valorDoFiltro(marcas()[0]!, "eq", "cobranca_ref")).toBe("ch_1");
    expect(valorDoFiltro(marcas()[0]!, "eq", "provedor")).toBe("stripe");
  });

  it("estorno do saldo inteiro grava `estornado`", async () => {
    await POST(post({ valor_cents: 10_000, ...visto }), ctx);
    expect(argumentos(marcas()[0]!, "update")?.[0]).toMatchObject({ status: "estornado", valor_estornado_cents: 10_000 });
  });

  it("provedor recusou: nada é marcado", async () => {
    h.estornarCobranca.mockRejectedValue(new ErroDoProvedor(400, "invalid_request_error", false));
    await POST(post({ valor_cents: 200, ...visto }), ctx);
    expect(marcas()).toEqual([]);
  });
});
