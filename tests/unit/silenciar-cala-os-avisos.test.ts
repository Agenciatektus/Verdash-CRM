import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SILENCIAR CALA OS AVISOS DE QUEM SILENCIOU, E SÓ DELE (migration 9042).
 *
 * Duas portas: o aviso do navegador (realtime de `messages`, que não sabe o
 * estado de cada pessoa, então consulta as listas em cache) e o push do
 * servidor (worker, que lê `conversation_user_state` com o service role).
 */

const enviados: string[] = [];
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => {
      enviados.push(sub.endpoint);
    }),
  },
}));
vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@invariant.test",
}));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv" } }));

let silenciaram: Array<{ user_id: string }> = [];
const filtrosDoSilencio: Record<string, unknown> = {};
// Se o envio abrir OUTRO service role para ler o silêncio, este dublê grita.
const createAdminClientMock = vi.fn(() => {
  throw new Error("o filtro do silêncio tem de usar o client injetado");
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClientMock() }));

import { aplicarEstadoNoCache, silenciadaNoCache } from "@/hooks/inbox/estadoNoCache";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";

const inscricoes = [
  { id: "1", endpoint: "https://fcm.googleapis.com/fcm/send/eu", p256dh: "p", auth: "a", user_id: "eu" },
  { id: "2", endpoint: "https://fcm.googleapis.com/fcm/send/colega", p256dh: "p", auth: "a", user_id: "colega" },
];
/** O client injetado: inscrições e, na mesma instância, o silêncio. */
const store = {
  from: (tabela: string) => {
    if (tabela === "conversation_user_state") {
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((filtrosDoSilencio[k] = v), q),
        gt: (k: string, v: unknown) => ((filtrosDoSilencio[`gt:${k}`] = v), Promise.resolve({ data: silenciaram, error: null })),
      };
      return q;
    }
    // Fork: o funil confere o vínculo ativo na organização e lê a política da tela bloqueada.
    if (tabela === "user_organizations") {
      const membros = [{ user_id: "eu", role: "agent" }, { user_id: "colega", role: "agent" }];
      return { select: () => ({ eq: () => ({ is: async () => ({ data: membros, error: null }) }) }) };
    }
    if (tabela === "organizations") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: {}, locale: "pt-BR" }, error: null }) }) }) };
    }
    return {
      select: () => ({ eq: async () => ({ data: inscricoes, error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
  },
};
const payload = { title: "Nova mensagem", body: "oi", tag: "msg:c1", href: "/app/inbox?id=c1" };

beforeEach(() => {
  enviados.length = 0;
  silenciaram = [];
  for (const k of Object.keys(filtrosDoSilencio)) delete filtrosDoSilencio[k];
});

describe("push do servidor", () => {
  it("quem silenciou a conversa não recebe; o colega recebe", async () => {
    silenciaram = [{ user_id: "eu" }];
    const r = await enviarPushDaOrg("org-1", payload, { conversationId: "c1" }, store as never);
    expect(enviados).toEqual(["https://fcm.googleapis.com/fcm/send/colega"]);
    expect(r.sent).toBe(1);
    // A leitura do silêncio é da conversa, na organização, e só o que vale AGORA.
    expect(filtrosDoSilencio).toMatchObject({ organization_id: "org-1", conversation_id: "c1" });
    expect(typeof filtrosDoSilencio["gt:muted_until"]).toBe("string");
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("falha ao ler o silêncio não cala ninguém", async () => {
    const quebrado = {
      from: (t: string) => (t === "conversation_user_state" ? (() => { throw new Error("boom"); })() : store.from(t)),
    };
    await enviarPushDaOrg("org-1", payload, { conversationId: "c1" }, quebrado as never);
    expect(enviados.sort()).toEqual(["https://fcm.googleapis.com/fcm/send/colega", "https://fcm.googleapis.com/fcm/send/eu"]);
  });

  it("CONTROLE: sem conversa (aviso que não é de mensagem), todo mundo recebe e o silêncio nem é lido", async () => {
    silenciaram = [{ user_id: "eu" }];
    await enviarPushDaOrg("org-1", payload, {}, store as never);
    expect(enviados.sort()).toEqual(["https://fcm.googleapis.com/fcm/send/colega", "https://fcm.googleapis.com/fcm/send/eu"]);
    expect(filtrosDoSilencio).toEqual({});
  });
});

describe("aviso do navegador", () => {
  function comLista(linhas: Array<Record<string, unknown>>) {
    const qc = new QueryClient();
    qc.setQueryData(["conversations", { status: ["open"] }], { pages: [{ data: linhas }], pageParams: [null] });
    return qc;
  }
  const AGORA = Date.parse("2026-10-07T12:00:00Z");

  it("silenciada 'sempre' ou até o futuro → calado; vencida ou sem estado → avisa", () => {
    const qc = comLista([
      { id: "sempre", muted_until: "infinity" },
      { id: "futuro", muted_until: "2026-10-07T13:00:00Z" },
      { id: "vencida", muted_until: "2026-10-07T11:00:00Z" },
      { id: "nada" },
    ]);
    expect(silenciadaNoCache(qc, "sempre", AGORA)).toBe(true);
    expect(silenciadaNoCache(qc, "futuro", AGORA)).toBe(true);
    expect(silenciadaNoCache(qc, "vencida", AGORA)).toBe(false);
    expect(silenciadaNoCache(qc, "nada", AGORA)).toBe(false);
    expect(silenciadaNoCache(qc, "fora-do-cache", AGORA)).toBe(false);
  });

  it("silenciar e reativar pelo menu corrigem a linha em cache na hora", () => {
    const qc = comLista([{ id: "c1", muted_until: null }]);
    aplicarEstadoNoCache(qc, "c1", { muted_until: "infinity" });
    expect(silenciadaNoCache(qc, "c1", AGORA)).toBe(true);
    aplicarEstadoNoCache(qc, "c1", { muted_until: null });
    expect(silenciadaNoCache(qc, "c1", AGORA)).toBe(false);
  });
});
