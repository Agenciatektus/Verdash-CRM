import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { elegivelParaReprocesso, selecionarParaReprocesso } from "@/lib/messaging/media/reprocesso-automatico";

/**
 * Reprocesso automático de mídia `failed`: teto de 3, intervalo de 10 min, janela de 48 h,
 * sem motivo permanente, sem org parada ou com leitura desligada. O cron só emite
 * `media.derive_requested` depois de gravar a contagem.
 */

const SEGREDO = "segredo-do-cron";
const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_PARADA = "33333333-3333-4333-8333-333333333333";
const ORG_SEM_LEITURA = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-11-03T12:00:00Z");
const min = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();

const msg = (id: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG,
  created_at: min(120),
  updated_at: min(60),
  metadata: { media_derived_motivo: "a derivação da imagem falhou em todas as tentativas: timeout", ...meta },
  ...over,
});

describe("regra pura", () => {
  const agora = AGORA.getTime();
  it("elegível: falha antiga o bastante, sem retries", () => {
    expect(elegivelParaReprocesso(msg("a"), agora)).toBe(true);
  });
  it("falha recente (< 35 min) espera", () => {
    expect(elegivelParaReprocesso(msg("a", { updated_at: min(20) }), agora)).toBe(false);
  });
  it("conta o intervalo a partir de derive_last_retry_at", () => {
    expect(elegivelParaReprocesso(msg("a", {}, { derive_retries: 1, derive_last_retry_at: min(30) }), agora)).toBe(false);
    expect(elegivelParaReprocesso(msg("a", {}, { derive_retries: 1, derive_last_retry_at: min(36) }), agora)).toBe(true);
  });
  it("3 reprocessos é o teto", () => {
    expect(elegivelParaReprocesso(msg("a", {}, { derive_retries: 2 }), agora)).toBe(true);
    expect(elegivelParaReprocesso(msg("a", {}, { derive_retries: 3 }), agora)).toBe(false);
  });
  it("fora da janela de 48 h não volta", () => {
    expect(elegivelParaReprocesso(msg("a", { created_at: min(49 * 60) }), agora)).toBe(false);
  });
  it("motivo permanente e mídia expirada não voltam", () => {
    expect(elegivelParaReprocesso(msg("a", {}, { media_derived_motivo: "áudio maior que 10 min não é transcrito" }), agora)).toBe(false);
    expect(elegivelParaReprocesso(msg("a", {}, { media_status: "expired" }), agora)).toBe(false);
  });
  it("respeita as orgs elegíveis e o lote", () => {
    const todas = [msg("1"), msg("2"), msg("3", { organization_id: ORG_PARADA })];
    expect(selecionarParaReprocesso(todas, agora, new Set([ORG])).map((m) => m.id)).toEqual(["1", "2"]);
    expect(selecionarParaReprocesso(todas, agora, new Set([ORG]), 1).map((m) => m.id)).toEqual(["1"]);
  });
});

// ─── rota ───────────────────────────────────────────────────────────────────
const emitidos: Array<Record<string, unknown>> = [];
const gravados: Array<{ id: string; metadata: Record<string, unknown>; filtros: unknown[][] }> = [];
const redigidas = new Set<string>();
const auditar = vi.fn();
let mensagens: Array<ReturnType<typeof msg>>;

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (_: string, args: Record<string, unknown>) => {
      emitidos.push(args);
      return Promise.resolve({ error: null });
    },
    from: (tabela: string) => {
      let update: { metadata: Record<string, unknown> } | null = null;
      let idAlvo = "";
      const filtros: unknown[][] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        update: (v: { metadata: Record<string, unknown> }) => ((update = v), chain),
        eq: (c: string, v: string) => ((c === "id" ? (idAlvo = v) : filtros.push(["eq", c, v])), chain),
        is: (c: string, v: unknown) => (filtros.push(["is", c, v]), chain),
        filter: (c: string, op: string, v: string) => (filtros.push(["filter", c, op, v]), chain),
        not: () => chain,
        gte: () => chain,
        or: () => chain,
        order: () => chain,
        in: () => chain,
        limit: () => chain,
        then: (res: (v: unknown) => unknown) => {
          if (update) {
            // Teto de descartável não traz `derive_retries` na guarda; o dublê só registra.
            gravados.push({ id: idAlvo, metadata: update.metadata, filtros });
            const casou = !redigidas.has(idAlvo);
            return Promise.resolve({ data: casou ? [{ id: idAlvo }] : [], error: null }).then(res);
          }
          const data =
            tabela === "messages"
              ? mensagens
              : [
                  { id: ORG, status: "active", settings: {} },
                  { id: ORG_PARADA, status: "suspended", settings: {} },
                  { id: ORG_SEM_LEITURA, status: "active", settings: { midia: { leitura_pela_ia: false } } },
                ];
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/media-derive-retry/route";

const chamar = (segredo = SEGREDO) =>
  GET(
    new NextRequest("http://local/api/v1/cron/media-derive-retry", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );

beforeEach(() => {
  emitidos.length = 0;
  gravados.length = 0;
  redigidas.clear();
  auditar.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});

describe("cron media-derive-retry", () => {
  it("sem segredo: 403", async () => {
    mensagens = [msg("1")];
    expect((await chamar("")).status).toBe(403);
    expect(emitidos).toHaveLength(0);
  });

  it("incrementa a contagem e reemite só quem pode", async () => {
    mensagens = [
      msg("ok", {}, { derive_retries: 1, derive_last_retry_at: min(40) }),
      msg("parada", { organization_id: ORG_PARADA }),
      msg("sem-leitura", { organization_id: ORG_SEM_LEITURA }),
      msg("recente", { updated_at: min(2) }),
    ];
    const res = await chamar();
    const corpo = (await res.json()) as { data: { reemitidas: number } };
    expect(corpo.data.reemitidas).toBe(1);
    expect(gravados).toHaveLength(1);
    expect(gravados[0].id).toBe("ok");
    expect(gravados[0].filtros).toContainEqual(["filter", "body", "isdistinct", "[mensagem anonimizada]"]);
    expect(gravados[0].filtros).toContainEqual(["eq", "metadata->>derive_retries", "1"]);
    expect(gravados[0].metadata.derive_retries).toBe(2);
    expect(gravados[0].metadata.derive_last_retry_at).toBe(AGORA.toISOString());
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({
      p_event_type: "media.derive_requested",
      p_entity_id: "ok",
      p_payload: { message_id: "ok" },
      p_metadata: { source: "retry_automatico" },
    });
    expect(auditar).toHaveBeenCalledTimes(1);
  });

  it("nada elegível: não emite e não audita", async () => {
    mensagens = [msg("x", {}, { derive_retries: 3 })];
    await chamar();
    expect(emitidos).toHaveLength(0);
    expect(auditar).not.toHaveBeenCalled();
  });

  it("sem reprocesso anterior a guarda otimista é derive_retries IS NULL", async () => {
    mensagens = [msg("novo")];
    await chamar();
    expect(gravados[0].filtros).toContainEqual(["is", "metadata->>derive_retries", null]);
  });

  it("mensagem redigida pela LGPD (0 linhas): não emite", async () => {
    mensagens = [msg("redigida")];
    redigidas.add("redigida");
    const res = await chamar();
    expect(((await res.json()) as { data: { reemitidas: number } }).data.reemitidas).toBe(0);
    expect(emitidos).toHaveLength(0);
  });

  it("motivo permanente: grava o teto (com a guarda LGPD) e não emite", async () => {
    mensagens = [msg("perm", {}, { media_derived_motivo: "áudio maior que 10 min não é transcrito" })];
    await chamar();
    expect(emitidos).toHaveLength(0);
    expect(gravados).toHaveLength(1);
    expect(gravados[0].metadata.derive_retries).toBe(3);
    expect(gravados[0].filtros).toContainEqual(["filter", "body", "isdistinct", "[mensagem anonimizada]"]);
  });
});
