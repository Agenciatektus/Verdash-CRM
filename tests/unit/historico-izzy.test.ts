import { describe, expect, it, vi } from "vitest";

import { FonteAdiada } from "@/lib/channels/historico/comum";
import { BASE_DO_IZZY, criarFonteIzzy, totalDeConversasDoIzzy } from "@/lib/channels/historico/fonte-izzy";

const TOKEN = "izzy_segredo_de_teste";
const agora = Math.floor(Date.now() / 1000);
const iso = (s: number) => new Date(s * 1000).toISOString();

type Resp = { status?: number; corpo?: unknown };
/** fetch de mentira: responde na ordem, guarda url e cabeçalhos. */
function fetchDe(respostas: Resp[]) {
  const chamadas: Array<{ url: string; auth: string | null }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    const r = respostas.shift() ?? { corpo: { data: [] } };
    return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status ?? 200 });
  });
  return { f: f as unknown as typeof fetch, chamadas };
}
const sem = async () => {};
const conversaComPrevia = { id: "c1", contact: { phone: "5511900000001", name: "Ana" }, last_message_preview: "oi" };

describe("fonte Izzy", () => {
  it("lista conversas com Bearer, paginação e telefone do contato embutido", async () => {
    const { f, chamadas } = fetchDe([
      {
        corpo: {
          data: [
            { id: "c1", contact: { phone: "5511900000001", name: "Ana" }, last_message_at: iso(agora - 100) },
            { id: "c2", contact: { phone: null } },
          ],
          meta: { total: 2 },
        },
      },
    ]);
    const fonte = criarFonteIzzy(TOKEN, { fetch: f, dormir: sem });
    const r = await fonte.paginaDeConversas("x", { limit: 50, offset: 100 });
    expect(r.lidas).toBe(2);
    expect(r.conversas).toEqual([{ chatId: "5511900000001@s.whatsapp.net", ultimaEm: agora - 100, posicao: 100 }]);
    expect(chamadas[0]!.url).toBe(`${BASE_DO_IZZY}/v1/conversations?limit=50&offset=100`);
    expect(chamadas[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("busca o contato quando a conversa não o traz", async () => {
    const { f, chamadas } = fetchDe([
      { corpo: { data: [{ id: "c1", contact_id: "k1" }] } },
      { corpo: { data: { phone: "5511900000002", name: "Bia" } } },
    ]);
    const r = await criarFonteIzzy(TOKEN, { fetch: f }).paginaDeConversas("x", { limit: 50, offset: 0 });
    expect(r.conversas[0]!.chatId).toBe("5511900000002@s.whatsapp.net");
    expect(chamadas[1]!.url).toContain("/v1/contacts/k1");
  });

  it("mensagens no formato real: direção, coex/echo, texto, áudio com marcador, janela", async () => {
    const msgs = {
      corpo: {
        data: [
          { id: "m1", content: "Quanto o iPhone 14?", message_type: "text", direction: "inbound", media_url: null, metadata: {}, created_at: iso(agora - 50) },
          { id: "m2", content: "", message_type: "audio", direction: "outbound", media_url: "https://x/x.ogg", media_mime_type: "audio/ogg", metadata: { coex: true }, created_at: iso(agora - 40) },
          { id: "m3", content: "eco", message_type: "text", direction: "inbound", metadata: { echo: true }, created_at: iso(agora - 30) },
          { id: "m4", content: "legenda", message_type: "image", direction: "outbound", metadata: {}, created_at: iso(agora - 20) },
          { id: "m5", content: "antiga", message_type: "text", direction: "inbound", created_at: iso(agora - 99999) },
        ],
      },
    };
    const { f, chamadas } = fetchDe([{ corpo: { data: [conversaComPrevia] } }, msgs]);
    const fonte = criarFonteIzzy(TOKEN, { fetch: f });
    const { conversas } = await fonte.paginaDeConversas("x", { limit: 50, offset: 0 });
    expect(conversas).toHaveLength(1); // telefone presente
    const r = await fonte.paginaDeMensagens("x", conversas[0]!.chatId, { limit: 100, offset: 0, desde: agora - 1000 });
    expect(r.lidas).toBe(5);
    expect(r.mensagens.map((m) => m.fromMe)).toEqual([false, true, true, true]);
    expect(r.mensagens[0]!.body).toBe("Quanto o iPhone 14?");
    expect(r.mensagens[1]!.body).toBe("[audio]");
    expect(r.mensagens[3]!.body).toBe("[image] legenda");
    expect(r.mensagens[0]!.id).toBe("false_5511900000001@s.whatsapp.net_izzy-m1");
    expect(chamadas[1]!.url).toContain("/v1/messages?conversation_id=c1&limit=100&offset=0");
  });

  it("vazio sob carga: repete até 2x e recupera", async () => {
    const vazio = { corpo: { data: [] } };
    const cheio = { corpo: { data: [{ id: "m1", content: "oi", message_type: "text", direction: "inbound", created_at: iso(agora - 5) }] } };
    const { f } = fetchDe([{ corpo: { data: [conversaComPrevia] } }, vazio, vazio, cheio]);
    const fonte = criarFonteIzzy(TOKEN, { fetch: f, dormir: sem });
    const { conversas } = await fonte.paginaDeConversas("x", { limit: 50, offset: 0 });
    const r = await fonte.paginaDeMensagens("x", conversas[0]!.chatId, { limit: 100, offset: 0, desde: 0 });
    expect(r.mensagens).toHaveLength(1);
  });

  it("vazio persistente com prévia adia a rodada; sem prévia é fim legítimo", async () => {
    const vazio = { corpo: { data: [] } };
    const com = fetchDe([{ corpo: { data: [conversaComPrevia] } }, vazio, vazio, vazio]);
    const a = criarFonteIzzy(TOKEN, { fetch: com.f, dormir: sem });
    const { conversas } = await a.paginaDeConversas("x", { limit: 50, offset: 0 });
    await expect(a.paginaDeMensagens("x", conversas[0]!.chatId, { limit: 100, offset: 0, desde: 0 })).rejects.toBeInstanceOf(FonteAdiada);

    const semPrevia = fetchDe([{ corpo: { data: [{ id: "c1", contact: { phone: "5511900000001" } }] } }, vazio]);
    const b = criarFonteIzzy(TOKEN, { fetch: semPrevia.f, dormir: sem });
    const c = await b.paginaDeConversas("x", { limit: 50, offset: 0 });
    expect((await b.paginaDeMensagens("x", c.conversas[0]!.chatId, { limit: 100, offset: 0, desde: 0 })).lidas).toBe(0);
  });

  it("429 vira FonteAdiada, não erro", async () => {
    const { f } = fetchDe([{ status: 429 }]);
    await expect(criarFonteIzzy(TOKEN, { fetch: f }).paginaDeConversas("x", { limit: 1, offset: 0 })).rejects.toBeInstanceOf(FonteAdiada);
  });

  it("o token não aparece em nenhuma mensagem de erro", async () => {
    for (const r of [{ status: 401 }, { status: 500 }, { corpo: "lixo" }]) {
      const { f } = fetchDe([r]);
      const err = await totalDeConversasDoIzzy(TOKEN, f).catch((e) => e as Error);
      expect((err as Error).message).not.toContain(TOKEN);
    }
    const falha = (async () => {
      throw new Error(`falhou ${BASE_DO_IZZY} Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await totalDeConversasDoIzzy(TOKEN, falha).catch((e) => e as Error);
    expect((err as Error).message).toBe("izzy_rede");
  });

  it("totalDeConversasDoIzzy lê meta.total", async () => {
    const { f, chamadas } = fetchDe([{ corpo: { data: [{ id: "c1" }], meta: { total: 321 } } }]);
    expect(await totalDeConversasDoIzzy(TOKEN, f)).toBe(321);
    expect(chamadas[0]!.url).toContain("/v1/conversations?limit=1");
  });
});
