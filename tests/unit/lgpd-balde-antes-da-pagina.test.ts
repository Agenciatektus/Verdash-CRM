/**
 * O filtro de balde da lista LGPD classifica ANTES de paginar.
 *
 * O defeito: "Em alerta" e "No prazo" filtravam a página já recortada pelo banco.
 * Com 1 por página, o pedido em alerta que caísse na página 2 sumia da página 1,
 * e o total contava pedidos de todos os baldes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeSlaBucket, corteDosUrgentes } from "@/lib/lgpd/balde-de-sla";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, user: { idioma: "pt-BR" }, org: { orgId: "org-1" } })),
}));

type Linha = { id: string; status: string; due_at: string | null; received_at: string };
let linhas: Linha[] = [];

/** Dublê do PostgREST: devolve as linhas na ordem do banco e respeita range/limit. */
function consulta() {
  let recorte: [number, number] | null = null;
  let teto: number | null = null;
  let soContagem = false;
  const q = {
    select: (_c: string, o?: { head?: boolean }) => ((soContagem = !!o?.head), q),
    eq: () => q,
    not: () => q,
    lt: () => q,
    order: () => q,
    range: (a: number, b: number) => ((recorte = [a, b]), q),
    limit: (n: number) => ((teto = n), q),
    then: (ok: (r: unknown) => void) => {
      if (soContagem) return ok({ count: linhas.length });
      let data = linhas;
      if (recorte) data = data.slice(recorte[0], recorte[1] + 1);
      if (teto !== null) data = data.slice(0, teto);
      return ok({ data, error: null });
    },
  };
  return q;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => consulta() }) }));

const { GET } = await import("@/app/api/v1/lgpd/requests/route");

const dia = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + n * 86_400_000).toISOString();
};

async function listar(qs: string) {
  const r = await GET(new NextRequest(`http://x/api/v1/lgpd/requests?${qs}`));
  return (await r.json()) as { data: Linha[]; meta: { total: number; has_more: boolean } };
}

describe("balde da LGPD antes da página", () => {
  beforeEach(() => {
    // Na ordem do banco (prazo crescente): o ok vem antes do warning.
    linhas = [
      { id: "ok-1", status: "received", due_at: dia(14), received_at: dia(-1) },
      { id: "alerta-1", status: "received", due_at: dia(20), received_at: dia(-30) },
    ];
  });

  it("o pedido em alerta da 'página 2' aparece na página 1 do filtro, e o total é do balde", async () => {
    expect(computeSlaBucket(linhas[1]!.due_at, linhas[1]!.received_at)).toBe("warning");
    const r = await listar("sla_bucket=warning&page=1&limit=1");
    expect(r.data.map((l) => l.id)).toEqual(["alerta-1"]);
    expect(r.meta.total).toBe(1);
    expect(r.meta.has_more).toBe(false);
  });

  it("only_count com balde conta só o balde", async () => {
    const r = await listar("sla_bucket=ok&only_count=true");
    expect(r.data).toEqual([]);
    expect(r.meta.total).toBe(1);
  });
});

describe("o corte dos urgentes bate com o balde, dia a dia", () => {
  it("abaixo do corte ⇔ vencido ou crítico", () => {
    const agora = new Date("2026-10-04T15:00:00-03:00");
    const recebido = "2026-09-20T12:00:00.000Z";
    const corte = corteDosUrgentes(agora);
    for (let n = -2; n <= 5; n++) {
      // `due_at` guarda o DIA: meia-noite UTC, como o motor grava.
      const due = new Date(Date.UTC(2026, 9, 4 + n)).toISOString();
      const balde = computeSlaBucket(due, recebido, agora);
      expect(due < corte, `dia ${n}: ${due} vs corte ${corte} (${balde})`).toBe(
        balde === "overdue" || balde === "critical",
      );
    }
  });
});
