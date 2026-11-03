import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { assumirPorRespostaHumana } from "@/lib/atendimento/assumir-por-resposta-humana";
import { avaliarDevolucao, type ConversaEmHandoff } from "@/lib/escalacao/devolucao-automatica";

const ORG = "o1";
const CONV = "c1";
const USER = "u1";

function fake(opts: { settings: unknown; conv: Record<string, unknown> | null; assignRows?: unknown[] }) {
  const chamadas = { rpc: [] as Array<Record<string, unknown>>, leadUpdate: null as Record<string, unknown> | null };
  const client = {
    from: (tabela: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        update: (v: Record<string, unknown>) => ((chamadas.leadUpdate = v), q),
        maybeSingle: () => Promise.resolve({ data: tabela === "organizations" ? { settings: opts.settings } : opts.conv, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      return q;
    },
    rpc: (_: string, args: Record<string, unknown>) => {
      chamadas.rpc.push(args);
      return Promise.resolve({ data: opts.assignRows ?? [{ id: CONV }], error: null });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, chamadas };
}
const args = { organizationId: ORG, conversationId: CONV, contactId: "k1", userId: USER };
const semDono = { assignee_kind: null, assigned_to_user_id: null, is_group: false };
const comPrazo = { routing: { handoff_return_after_minutes: 60 } };

describe("assumirPorRespostaHumana", () => {
  it("org com prazo e conversa sem responsável: atribui e o negócio herda o dono", async () => {
    const { client, chamadas } = fake({ settings: comPrazo, conv: semDono });
    expect(await assumirPorRespostaHumana(client, args)).toBe(true);
    expect(chamadas.rpc[0]).toMatchObject({ p_to_user_id: USER, p_reason: "resposta_humana_crm", p_enforce_expected: true });
    expect(chamadas.leadUpdate).toMatchObject({ owner_user_id: USER, owner_agent_id: null, owner_kind: "user" });
  });

  it("org sem prazo: comportamento de hoje, nada é gravado", async () => {
    for (const settings of [{}, null, { routing: {} }, { routing: { handoff_return_after_minutes: 1 } }]) {
      const { client, chamadas } = fake({ settings, conv: semDono });
      expect(await assumirPorRespostaHumana(client, args)).toBe(false);
      expect(chamadas.rpc).toHaveLength(0);
      expect(chamadas.leadUpdate).toBeNull();
    }
  });

  it("conversa que já tem humano, ou grupo: não troca de dono", async () => {
    for (const conv of [
      { assignee_kind: "user", assigned_to_user_id: "outro", is_group: false },
      { assignee_kind: null, assigned_to_user_id: "outro", is_group: false },
      { ...semDono, is_group: true },
    ]) {
      const { client, chamadas } = fake({ settings: comPrazo, conv });
      expect(await assumirPorRespostaHumana(client, args)).toBe(false);
      expect(chamadas.rpc).toHaveLength(0);
    }
  });

  it("corrida: RPC não casou nenhuma linha, o negócio não é tocado", async () => {
    const { client, chamadas } = fake({ settings: comPrazo, conv: semDono, assignRows: [] });
    expect(await assumirPorRespostaHumana(client, args)).toBe(false);
    expect(chamadas.leadUpdate).toBeNull();
  });
});

describe("o cron de devolução trata o auto-claim como qualquer humano", () => {
  const agoraMs = Date.parse("2026-11-03T12:00:00Z");
  const min = (n: number) => new Date(agoraMs - n * 60_000).toISOString();
  // O que fn_conversation_assign deixa: kind 'user', status 'claimed', assigned_at; sem bot_silenced infinity.
  const claimed = (minutos: number): ConversaEmHandoff => ({
    id: CONV,
    organization_id: ORG,
    channel_session_id: "s1",
    status: "claimed",
    assignee_kind: "user",
    assigned_to_user_id: USER,
    assigned_at: min(minutos),
    bot_silenced_until: min(minutos - 5),
    last_handoff_at: null,
    last_handoff_reason: null,
    last_outbound_at: min(minutos),
    status_changed_at: min(minutos),
  });
  const sel = {
    prazoPorOrg: new Map([[ORG, 60]]),
    sessoesComAgente: new Map([[ORG, new Set(["s1"])]]),
    agoraMs,
  };
  it("dentro do prazo fica com o humano; passado o prazo a IA volta", () => {
    expect(avaliarDevolucao(claimed(30), sel)).toEqual({ devolver: false, motivo: "dentro_do_prazo" });
    expect(avaliarDevolucao(claimed(61), sel)).toEqual({ devolver: true, minutos: 60 });
  });
});
