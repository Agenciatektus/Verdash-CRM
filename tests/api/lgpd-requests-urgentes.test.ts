/**
 * `GET /api/v1/lgpd/requests?sla_bucket=urgent` filtra NO BANCO, antes da página.
 *
 * O defeito que isto segura: o filtro "urgentes" rodava no cliente sobre a página
 * carregada. Com 25 concluídos antigos na página 1 (a rota ordena por `due_at`), a
 * urgente caía na página 2 e a tela dizia "Nenhuma solicitação".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "@/app/api/v1/lgpd/requests/route";

type Row = Record<string, unknown>;

const linha = (id: string, status: string, due: string): Row => ({
  id,
  organization_id: "org",
  request_type: "redact",
  status,
  received_at: "2026-09-01T00:00:00.000Z",
  due_at: due,
});

const LINHAS: Row[] = [
  ...Array.from({ length: 25 }, (_, i) => linha(`done-${i}`, "completed", "2026-09-10T00:00:00.000Z")),
  linha("urgente", "received", "2026-10-06T00:00:00.000Z"),
  linha("longe", "received", "2026-10-20T00:00:00.000Z"),
];

/** Um PostgREST de bolso: eq, not-in, lt, order, range e count, sobre `LINHAS`. */
function fakeDb() {
  return {
    from() {
      let rows = [...LINHAS];
      let head = false;
      let faixa: [number, number] | null = null;
      const b: Record<string, unknown> = {
        select: (_c: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b),
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v || c === "organization_id")), b),
        not: (c: string, _op: string, v: string) => {
          const fora = v.replace(/[()]/g, "").split(",");
          rows = rows.filter((r) => !fora.includes(r[c] as string));
          return b;
        },
        lt: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) < v)), b),
        order: () => ((rows = [...rows].sort((a, c) => String(a.due_at).localeCompare(String(c.due_at)))), b),
        range: (a: number, z: number) => ((faixa = [a, z]), b),
        then: (ok: (v: unknown) => unknown) =>
          ok(
            head
              ? { count: rows.length, data: null, error: null }
              : { data: faixa ? rows.slice(faixa[0], faixa[1] + 1) : rows, error: null },
          ),
      };
      return b;
    },
  };
}

async function chamar(qs: string) {
  const res = await GET(new NextRequest(`http://x/api/v1/lgpd/requests?${qs}`));
  return res.json();
}

describe("GET /lgpd/requests?sla_bucket=urgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { idioma: "pt-BR" },
      org: { orgId: "org" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(fakeDb() as never);
  });
  afterEach(() => vi.useRealTimers());

  it("sem o filtro, a página 1 é só de concluídos (o cenário do defeito)", async () => {
    const r = await chamar("limit=25");
    expect(r.data.every((x: Row) => x.status === "completed")).toBe(true);
  });

  it("com o filtro, devolve a urgente (em aberto) e o total certo, ignorando os concluídos", async () => {
    const r = await chamar("sla_bucket=urgent&limit=25");
    expect(r.data.map((x: Row) => x.id)).toEqual(["urgente"]);
    expect(r.meta.total).toBe(1);
    expect(r.meta.has_more).toBe(false);
  });

  it("only_count devolve só o total, sem linhas", async () => {
    const r = await chamar("only_count=true");
    expect(r.data).toEqual([]);
    expect(r.meta.total).toBe(LINHAS.length);
  });
});
