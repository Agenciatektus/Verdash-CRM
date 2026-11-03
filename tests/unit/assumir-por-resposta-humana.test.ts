import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { assumirPorRespostaHumana } from "@/lib/atendimento/assumir-por-resposta-humana";
import { avaliarDevolucao, type ConversaEmHandoff } from "@/lib/escalacao/devolucao-automatica";

const ORG = "o1";
const CONV = "c1";
const USER = "u1";

const adotar = vi.fn();
vi.mock("@/lib/routing/worker", () => ({ adotarLeadsDoContato: (...a: unknown[]) => adotar(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => "ADMIN" }));
let servico = true;
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => servico }));

function fake(assignRows: unknown[] = [{ id: CONV }]) {
  const rpc = vi.fn(() => Promise.resolve({ data: assignRows, error: null }));
  // Qualquer leitura é falha: o helper não pode tocar o banco fora da RPC.
  const from = vi.fn(() => {
    throw new Error("leitura extra");
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { rpc, from } as any, rpc, from };
}
const semDono = { status: "open", assignee_kind: null, assigned_to_user_id: null, is_group: false };
const comPrazo = { routing: { handoff_return_after_minutes: 60 } };
const args = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  conversationId: CONV,
  contactId: "k1",
  userId: USER,
  settings: comPrazo,
  conversa: semDono,
  ...over,
});

beforeEach(() => {
  adotar.mockReset();
  servico = true;
});

describe("assumirPorRespostaHumana", () => {
  it("org com prazo e conversa sem responsável: atribui, sem leitura extra, e o negócio sem dono é adotado (sem substituir)", async () => {
    const { client, rpc, from } = fake();
    expect(await assumirPorRespostaHumana(client, args())).toBe(true);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_to_user_id: USER, p_reason: "resposta_humana_crm", p_enforce_expected: true });
    expect(from).not.toHaveBeenCalled();
    expect(adotar).toHaveBeenCalledWith("ADMIN", ORG, "k1", USER);
  });

  it("sem service role configurado: atribui a conversa, não adota o negócio", async () => {
    servico = false;
    const { client } = fake();
    expect(await assumirPorRespostaHumana(client, args())).toBe(true);
    expect(adotar).not.toHaveBeenCalled();
  });

  it("org sem prazo: comportamento de hoje, nada é gravado", async () => {
    for (const settings of [{}, null, undefined, { routing: {} }, { routing: { handoff_return_after_minutes: 1 } }]) {
      const { client, rpc } = fake();
      expect(await assumirPorRespostaHumana(client, args({ settings }))).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
      expect(adotar).not.toHaveBeenCalled();
    }
  });

  it("conversa com humano, grupo ou encerrada: não troca nem reabre", async () => {
    for (const conversa of [
      { ...semDono, assignee_kind: "user", assigned_to_user_id: "outro" },
      { ...semDono, assigned_to_user_id: "outro" },
      { ...semDono, is_group: true },
      { ...semDono, status: "closed" },
      { ...semDono, status: "resolved" },
    ]) {
      const { client, rpc } = fake();
      expect(await assumirPorRespostaHumana(client, args({ conversa }))).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("corrida: RPC não casou nenhuma linha, o negócio não é tocado", async () => {
    const { client } = fake([]);
    expect(await assumirPorRespostaHumana(client, args())).toBe(false);
    expect(adotar).not.toHaveBeenCalled();
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
