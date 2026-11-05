import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, valorDoFiltro, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ sincronizar: vi.fn(), aplicarRegua: vi.fn(), compras: vi.fn(), efeito: vi.fn() }));
vi.mock("./compra", () => ({ processarComprasPendentes: h.compras }));
vi.mock("./compra-efeitos", () => ({ efeitosDaCompra: () => ({ aoCriar: h.efeito, aoDuplicar: h.efeito }) }));
vi.mock("./sincronizar", () => ({ sincronizar: h.sincronizar, aplicarRegua: h.aplicarRegua }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { LIMITE_DA_RECONCILIACAO, limiarDoAviso, rodadaDaCobranca } from "./rodada";

interface Mundo {
  reconciliaveis: Array<{ organization_id: string; relida_em: string | null; precisa_reler: boolean }>;
  todas: string[];
  planos: Array<{ id: string; teto_ia_usd_cents: number; aviso_ia_usd_cents?: number | null }>;
  assinaturasDePlano: Array<{ organization_id: string; plano_id: string }>;
  orgs: Array<{ id: string; status: string; locale: string | null }>;
  gasto: Record<string, number>;
  flag: string | null;
}
let m: Mundo;
let banco: BancoFalso;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "platform_config") return { data: m.flag === null ? null : { valor: m.flag } };
  if (c.tabela === "cobranca_planos") return { data: m.planos };
  if (c.tabela === "organizations") return { data: m.orgs };
  if (valorDoFiltro(c, "in", "plano_id") !== undefined) return { data: m.assinaturasDePlano };
  return { data: m.todas.map((organization_id) => ({ organization_id })) };
}
function rpc(nome: string, args: Record<string, unknown>): Resposta {
  if (nome === "fn_cobranca_reconciliaveis") return { data: m.reconciliaveis };
  if (nome === "fn_gasto_de_ia_do_mes") return { data: m.gasto[String(args.p_org)] ?? 0 };
  return { data: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  m = { reconciliaveis: [], todas: [], planos: [], assinaturasDePlano: [], orgs: [], gasto: {}, flag: null };
  h.compras.mockResolvedValue({ lidas: 0, criadas: 0, falhas: 0 });
  banco = bancoFalso(responder, rpc);
  h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "ativa", mudou: false, acao: "nada" });
  h.aplicarRegua.mockResolvedValue("nada");
});

const rodar = () => rodadaDaCobranca(banco.cliente as never);
const orgsSincronizadas = () => h.sincronizar.mock.calls.map((c) => c[1]);

describe("rodadaDaCobranca", () => {
  it("⭐ relê só quem precisa, nunca lida primeiro, no máximo 50", async () => {
    m.reconciliaveis = [
      ...Array.from({ length: 58 }, (_, i) => ({ organization_id: `lida-${i}`, relida_em: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), precisa_reler: true })),
      { organization_id: "nunca", relida_em: null, precisa_reler: true },
      { organization_id: "fresca", relida_em: new Date().toISOString(), precisa_reler: false },
    ];
    const r = await rodar();
    expect(orgsSincronizadas()).toHaveLength(LIMITE_DA_RECONCILIACAO);
    expect(orgsSincronizadas()[0]).toBe("nunca");
    expect(orgsSincronizadas()[1]).toBe("lida-0");
    expect(orgsSincronizadas()).not.toContain("fresca");
    expect(r.relidas).toBe(50);
  });

  it("⭐ leitura que falha na reconciliação não deixa a régua rodar para essa empresa", async () => {
    m.reconciliaveis = [{ organization_id: "A", relida_em: null, precisa_reler: true }];
    m.todas = ["A", "B"];
    h.sincronizar.mockResolvedValue({ tipo: "falhou", erro: "provedor_fora", transitorio: true });
    const r = await rodar();
    expect(h.aplicarRegua.mock.calls.map((c) => c[1])).toEqual(["B"]);
    expect(r.falhas).toBe(1);
  });

  it("régua só com o banco para quem não foi relido, e as contagens saem por ação", async () => {
    m.reconciliaveis = [{ organization_id: "A", relida_em: null, precisa_reler: true }];
    m.todas = ["A", "B", "C", "D"];
    h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "em_atraso", mudou: false, acao: "suspender" });
    h.aplicarRegua.mockImplementation(async (_db: unknown, org: string) => ({ B: "avisar", C: "reativar", D: "cancelar_no_provedor" })[org] ?? "nada");
    expect(await rodar()).toEqual({ relidas: 1, falhas: 0, avisos: 1, suspensas: 1, reativadas: 1, canceladas: 1, avisosDeIa: 0 });
  });

  it("⭐ empresa sem provedor na fila: a ação da régua que sincronizar já executou entra no resumo", async () => {
    m.reconciliaveis = [{ organization_id: "A", relida_em: null, precisa_reler: true }];
    h.sincronizar.mockResolvedValue({ tipo: "sem_provedor", acao: "suspender" });
    expect(await rodar()).toMatchObject({ relidas: 0, falhas: 0, suspensas: 1 });
  });

  it("a falha de uma empresa não derruba a rodada", async () => {
    m.todas = ["A", "B"];
    h.aplicarRegua.mockImplementation(async (_db: unknown, org: string) => {
      if (org === "A") throw new Error("boom");
      return "avisar";
    });
    expect(await rodar()).toMatchObject({ falhas: 1, avisos: 1 });
  });

  it("aviso de 80% da IA: só empresa operante, entre 80% e 100% do teto, com o gasto no texto", async () => {
    m.planos = [{ id: "p1", teto_ia_usd_cents: 1000 }];
    m.assinaturasDePlano = [
      { organization_id: "A", plano_id: "p1" },
      { organization_id: "B", plano_id: "p1" },
      { organization_id: "C", plano_id: "p1" },
    ];
    m.orgs = [
      { id: "A", status: "active", locale: "pt-BR" },
      { id: "B", status: "suspended", locale: "pt-BR" },
      { id: "C", status: "active", locale: "pt-BR" },
    ];
    m.gasto = { A: 850, B: 900, C: 1000 };
    const r = await rodar();
    const avisos = banco.rpcs.filter((x) => x.nome === "fn_cobranca_avisar_teto_de_ia");
    expect(avisos.map((a) => a.args.p_org)).toEqual(["A"]);
    expect(String(avisos[0]?.args.p_corpo)).toContain("US$ 8.50 de US$ 10.00");
    expect(r.avisosDeIa).toBe(1);
  });

  it("⭐ aviso gravado no plano (9098): plano sem IA avisa a partir de US$ 3 e para em US$ 6", async () => {
    m.planos = [{ id: "p1", teto_ia_usd_cents: 600, aviso_ia_usd_cents: 300 }];
    m.assinaturasDePlano = [
      { organization_id: "A", plano_id: "p1" },
      { organization_id: "B", plano_id: "p1" },
    ];
    m.orgs = [
      { id: "A", status: "active", locale: "pt-BR" },
      { id: "B", status: "active", locale: "pt-BR" },
    ];
    m.gasto = { A: 320, B: 290 };
    const r = await rodar();
    const avisos = banco.rpcs.filter((x) => x.nome === "fn_cobranca_avisar_teto_de_ia");
    expect(avisos.map((a) => a.args.p_org)).toEqual(["A"]);
    expect(String(avisos[0]?.args.p_corpo)).toContain("US$ 3.20 de US$ 6.00");
    expect(r.avisosDeIa).toBe(1);
  });

  it("limiarDoAviso: aviso nulo, zero ou >= teto cai nos 80% do teto", () => {
    expect(limiarDoAviso(1000, 600)).toBe(600);
    expect(limiarDoAviso(1000, null)).toBe(800);
    expect(limiarDoAviso(1000, 0)).toBe(800);
    expect(limiarDoAviso(600, 600)).toBe(480);
  });

  it("venda direta desligada: não repassa as compras e o resumo não ganha o campo", async () => {
    const r = await rodar();
    expect(h.compras).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty("compras");
  });

  it("venda direta ligada: repassa as compras pendentes e soma o resumo", async () => {
    m.flag = "ligado";
    h.compras.mockResolvedValue({ lidas: 3, criadas: 2, falhas: 1 });
    const r = await rodar();
    expect(h.compras).toHaveBeenCalledTimes(1);
    expect(h.compras.mock.calls[0]?.[0]).toBe(banco.cliente);
    expect(h.compras.mock.calls[0]?.[1]).toEqual({ aoCriar: h.efeito, aoDuplicar: h.efeito });
    expect(r.compras).toEqual({ lidas: 3, criadas: 2, falhas: 1 });
  });

  it("venda direta ligada com erro nas compras: a rodada não cai e o resto do resumo sai", async () => {
    m.flag = "ligado";
    m.reconciliaveis = [{ organization_id: "A", relida_em: null, precisa_reler: true }];
    h.compras.mockRejectedValue(new Error("fila fora"));
    const r = await rodar();
    expect(r.relidas).toBe(1);
    expect(r).not.toHaveProperty("compras");
  });
});
