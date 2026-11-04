import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ pode: vi.fn(), env: { AI_PREVIEW_MAX_POR_HORA: "" } }));
vi.mock("@/lib/ai/budget/pode-gastar", () => ({ podeGastarComIa: m.pode }));
vi.mock("@/lib/env", () => ({ env: m.env }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  confirmarUnicoEmVoo, normalizarLimiteDePreviews, travaDoPreview,
} from "@/lib/ai/budget/trava-do-preview";

/** Dublê de ai_agent_runs: conta por filtro `status` (running) ou geral (hora). */
function banco(o: { running?: number; hora?: number; erro?: boolean }) {
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from: () => ({
      select() {
        const f: Record<string, unknown> = {};
        const q: Record<string, unknown> = {
          eq(c: string, v: unknown) { f[c] = v; return q; },
          gte: async () => (o.erro
            ? { count: null, error: { message: "boom" } }
            : { count: f.status === "running" ? (o.running ?? 0) : (o.hora ?? 0), error: null }),
        };
        return q;
      },
      update(d: Record<string, unknown>) {
        updates.push(d);
        const q: Record<string, unknown> = { eq: () => q, then: (r: (v: { error: null }) => void) => r({ error: null }) };
        return q;
      },
    }),
  };
  return { admin: admin as never, updates };
}
const AGORA = new Date("2026-11-04T12:00:00Z");

describe("travaDoPreview", () => {
  beforeEach(() => {
    m.pode.mockResolvedValue({ pode: true, porque: "modo_off" });
    m.env.AI_PREVIEW_MAX_POR_HORA = "";
  });

  it("teto mensal estourado recusa com orcamento_atingido", async () => {
    m.pode.mockResolvedValue({ pode: false, porque: "teto_atingido", gastoCents: 10, tetoCents: 5 });
    const r = await travaDoPreview(banco({}).admin, "org", AGORA);
    expect(r).toMatchObject({ ok: false, codigo: "orcamento_atingido", status: 429 });
    expect(m.pode).toHaveBeenCalledWith("org", "agent_preview");
  });

  it("um preview já rodando recusa com preview_em_andamento", async () => {
    const r = await travaDoPreview(banco({ running: 1 }).admin, "org", AGORA);
    expect(r).toMatchObject({ ok: false, codigo: "preview_em_andamento", status: 429 });
  });

  it("rajada: no limite padrão (10) recusa; abaixo passa", async () => {
    expect(await travaDoPreview(banco({ hora: 10 }).admin, "org", AGORA))
      .toMatchObject({ ok: false, codigo: "limite_de_previews", status: 429 });
    expect(await travaDoPreview(banco({ hora: 9 }).admin, "org", AGORA)).toEqual({ ok: true });
  });

  it("env respeitado quando válido", async () => {
    m.env.AI_PREVIEW_MAX_POR_HORA = "3";
    expect(await travaDoPreview(banco({ hora: 3 }).admin, "org", AGORA)).toMatchObject({ ok: false, codigo: "limite_de_previews" });
  });

  it("env inválido ou <=0 volta ao padrão 10, sem lançar", () => {
    for (const cru of ["abc", "0", "-5", "", undefined]) expect(normalizarLimiteDePreviews(cru)).toBe(10);
    expect(normalizarLimiteDePreviews(" 4 ")).toBe(4);
  });

  it("erro de leitura recusa (fail-closed)", async () => {
    const r = await travaDoPreview(banco({ erro: true }).admin, "org", AGORA);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });
});

describe("confirmarUnicoEmVoo", () => {
  it("sozinho segue; com concorrente aborta o próprio run", async () => {
    const so = banco({ running: 1 });
    expect(await confirmarUnicoEmVoo(so.admin, "org", "run", AGORA)).toBe(true);
    expect(so.updates).toHaveLength(0);
    const dois = banco({ running: 2 });
    expect(await confirmarUnicoEmVoo(dois.admin, "org", "run", AGORA)).toBe(false);
    expect(dois.updates[0]).toMatchObject({ status: "aborted", error_code: "preview_concorrente" });
  });
});
