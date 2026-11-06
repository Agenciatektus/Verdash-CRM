// @vitest-environment node
/**
 * DRENO CEGO NÃO BATE (P1 do @Cassio_SecRev na #61).
 *
 * O batimento cala o cron `event-log-drain`. Se o worker batesse com o tick
 * CEGO — select do lote ou dos presos falhando (URL/chave erradas, PostgREST
 * inalcançável da rede do worker) ou nenhum handler registrado —, o cron
 * responderia `worker_drenando` para sempre com o event_log parado, sem erro em
 * lugar nenhum. `drainEventLog` devolvia resumo zerado nesses casos (e no de
 * status das organizações indisponível, que adia o lote), igual ao
 * de fila vazia; agora marca `erro`, e o laço só bate sem ele.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@/lib/agent-engine/obs/logger";

vi.mock("@/lib/env", () => ({ env: {} }));

const handlers = vi.fn();
vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => handlers(),
  dispatchEvent: vi.fn(async () => []),
}));

const { drainEventLog } = await import("@/lib/event-log/drain");
const { runEventLogDrainLoop } = await import("@/lib/event-log/drain-loop");

const FALHA = { message: "fetch failed" };

/** Dublê mínimo: o select com `status = processing` é o dos presos; o outro, o do lote. */
function dublarAdmin(
  opts: { presosFalha?: boolean; loteFalha?: boolean; orgsFalha?: boolean } = {},
) {
  function cadeia(tabela: string) {
    let pedePresos = false;
    const self: Record<string, unknown> = {
      select: () => self,
      update: () => self,
      eq: (c: string, v: unknown) => {
        if (c === "status" && v === "processing") pedePresos = true;
        return self;
      },
      lt: () => self,
      or: () => self,
      in: () => self,
      order: () => self,
      limit: () => self,
      then: (resolve: (r: unknown) => void) => {
        if (tabela === "organizations") {
          resolve(opts.orgsFalha ? { data: null, error: FALHA } : { data: [], error: null });
          return;
        }
        // Com `orgsFalha`, o lote traz uma linha para o tick precisar do status da org.
        const lote = opts.orgsFalha
          ? [{ id: "e1", organization_id: "o1", event_type: "knowledge_source.updated", attempts: 0 }]
          : [];
        if (pedePresos) resolve(opts.presosFalha ? { data: null, error: FALHA } : { data: [], error: null });
        else resolve(opts.loteFalha ? { data: null, error: FALHA } : { data: lote, error: null });
      },
    };
    return self;
  }
  return { from: (t: string) => cadeia(t) } as never;
}

beforeEach(() => {
  handlers.mockReset();
  handlers.mockReturnValue([{ key: "k", events: ["knowledge_source.updated"] }]);
});
afterEach(() => vi.useRealTimers());

describe("drainEventLog distingue fila vazia de fila que não viu", () => {
  it("controle: fila vazia e saudável → sem erro", async () => {
    const r = await drainEventLog(dublarAdmin());
    expect(r.erro).toBeUndefined();
  });

  it("select do lote falhou → erro", async () => {
    expect((await drainEventLog(dublarAdmin({ loteFalha: true }))).erro).toMatch(/lote/);
  });

  it("select de presos falhou → erro", async () => {
    expect((await drainEventLog(dublarAdmin({ presosFalha: true }))).erro).toMatch(/presos/);
  });

  it("status das organizações indisponível → erro", async () => {
    expect((await drainEventLog(dublarAdmin({ orgsFalha: true }))).erro).toMatch(/organiza/);
  });

  it("zero handlers → erro", async () => {
    handlers.mockReturnValue([]);
    expect((await drainEventLog(dublarAdmin())).erro).toMatch(/handler/);
  });
});

describe("o laço do worker só bate com o tick que viu a fila", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const knobs = { intervalMs: 2_000, idleIntervalMs: 2_000, idleMaxMs: 2_000, staleSweepMs: 60_000, batchSize: 50 };

  async function batidas(admin: never): Promise<number> {
    vi.useFakeTimers();
    const set = vi.fn(async () => "OK");
    const controller = new AbortController();
    const loop = runEventLogDrainLoop(knobs, log, controller.signal, { deps: {
      // O drainEventLog REAL, com o dublê do banco: é o caminho que o P1 apontou.
      drainEventLog,
      admin: admin as never,
      batimento: { get: vi.fn(), set },
    } });
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    await loop;
    return set.mock.calls.length;
  }

  it("controle positivo: tick saudável → bate", async () => {
    expect(await batidas(dublarAdmin())).toBeGreaterThan(0);
  });

  it("select do lote falhou → não bate", async () => {
    expect(await batidas(dublarAdmin({ loteFalha: true }))).toBe(0);
  });

  it("select de presos falhou → não bate", async () => {
    expect(await batidas(dublarAdmin({ presosFalha: true }))).toBe(0);
  });

  it("status das organizações indisponível → não bate", async () => {
    expect(await batidas(dublarAdmin({ orgsFalha: true }))).toBe(0);
  });

  it("zero handlers → não bate", async () => {
    handlers.mockReturnValue([]);
    expect(await batidas(dublarAdmin())).toBe(0);
  });
});
