import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mensagem de grupo do canal Verdash vai para `gravarMensagemDeGrupo`, que só grava grupo LIGADO.
 * Antes (até 06/11/2026) o ingest descartava todo `@g.us`, e como o WAHA foi desligado,
 * nenhum grupo entrava no CRM: 0 linhas em `channel_session_groups` e 0 conversas de grupo.
 */
const gravar = vi.fn();
vi.mock("@/lib/grupos/ingest", () => ({
  criarIngestDeGrupoDb: () => ({ inserirMensagem: async () => ({ status: "ok", messageId: "msg-1" }) }),
  gravarMensagemDeGrupo: (...a: unknown[]) => gravar(...a),
}));

import { ingestVerdashInbound } from "@/lib/channels/verdash/ingest";

const GRUPO = "120363025407046714@g.us";

function payload(message: Record<string, unknown>, info: Record<string, unknown> = {}) {
  return {
    type: "Message",
    event: {
      Info: {
        ID: "3AGRUPO0001",
        Chat: GRUPO,
        Sender: "5511988887777@s.whatsapp.net",
        IsFromMe: false,
        IsGroup: true,
        PushName: "Maria",
        Timestamp: "2026-11-06T10:00:00-03:00",
        ...info,
      },
      Message: message,
    },
  };
}

function admin() {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { id: "msg-1", conversation_id: "conv-1" }, error: null }),
  };
  return { rpc, from: vi.fn(() => q) };
}

const entrada = (p: unknown, a = admin()) =>
  ingestVerdashInbound(a as never, { organizationId: "org-1", channelSessionId: "sess-1", payload: p });

beforeEach(() => {
  gravar.mockReset();
});

describe("canal Verdash: mensagem de grupo", () => {
  it("texto de grupo chega ao ingest de grupos com o remetente do Sender", async () => {
    // O dublê grava como o real: pelo `inserirMensagem` do db que recebeu.
    gravar.mockImplementation(async (db: { inserirMensagem(r: unknown): Promise<unknown> }) => {
      await db.inserirMensagem({ conversation_id: "conv-1" });
      return "gravada";
    });
    const a = admin();
    const r = await entrada(payload({ conversation: "bom dia, grupo" }), a);
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });
    const [, e] = gravar.mock.calls[0]!;
    expect(e).toMatchObject({
      organizationId: "org-1",
      channelSessionId: "sess-1",
      groupChatId: GRUPO,
      direction: "inbound",
      externalId: "3AGRUPO0001",
      type: "text",
      body: "bom dia, grupo",
      remetente: { name: "Maria", phone: "+5511988887777", lid: null },
    });
  });

  it("grupo desligado não grava nada e diz por quê", async () => {
    gravar.mockResolvedValue("grupo_desligado");
    const a = admin();
    expect(await entrada(payload({ conversation: "oi" }), a)).toEqual({ status: "ignored", reason: "grupo_desligado" });
  });

  it("mensagem que SAIU do celular entra sem remetente (quem falou é o dono do número)", async () => {
    gravar.mockResolvedValue("gravada");
    await entrada(payload({ conversation: "respondi do celular" }, { IsFromMe: true, PushName: "Loja" }));
    expect(gravar.mock.calls[0]![1]).toMatchObject({ direction: "outbound", remetente: null });
  });

  it("edição em grupo não vira mensagem nova", async () => {
    const r = await entrada(payload({ protocolMessage: { key: { ID: "ORIG" }, type: 14, editedMessage: { conversation: "x" } } }));
    expect(r.status).toBe("ignored");
    expect(gravar).not.toHaveBeenCalled();
  });
});

describe("lista de grupos do número (Conexões › Grupos)", () => {
  it("lê os envelopes do FZAP e da Verdash e descarta o que não é grupo", async () => {
    const { gruposDaLista } = await import("@/lib/channels/verdash/client");
    const so = (l: unknown) => gruposDaLista(l).map((g) => ({ chatId: g.chatId, subject: g.subject }));
    expect(so([{ JID: "1-2@g.us", Name: "Equipe" }, { JID: "5511@s.whatsapp.net", Name: "p" }])).toEqual([{ chatId: "1-2@g.us", subject: "Equipe" }]);
    expect(so({ Groups: [{ JID: "9@g.us", Name: " " }] })).toEqual([{ chatId: "9@g.us", subject: null }]);
    expect(so([{ chatId: "7@g.us", subject: "Vendas" }])).toEqual([{ chatId: "7@g.us", subject: "Vendas" }]);
    expect(gruposDaLista(null)).toEqual([]);
  });

  it("modo direto: calcula contagens e tipo do FZAP cru, sem devolver participantes", async () => {
    const { gruposDaLista } = await import("@/lib/channels/verdash/client");
    const [g, com, filho] = gruposDaLista([
      { jid: "1@g.us", name: "G", participantCount: 8, isAnnounce: true, participants: [{ jid: "a", isAdmin: true }, { jid: "b", isSuperAdmin: true }, { jid: "c" }] },
      { jid: "2@g.us", name: "C", isParent: true },
      { jid: "3@g.us", name: "F", linkedParentJid: "2@g.us" },
    ]);
    expect(g).toEqual({ chatId: "1@g.us", subject: "G", participantCount: 8, adminCount: 2, papel: null, isAnnounce: true, tipo: "grupo" });
    expect(com?.tipo).toBe("comunidade");
    expect(filho?.tipo).toBe("grupo_da_comunidade");
  });

  it("modo pareado: aceita o que a Verdash já devolve pronto", async () => {
    const { gruposDaLista } = await import("@/lib/channels/verdash/client");
    expect(gruposDaLista([{ chatId: "4@g.us", subject: "P", participantCount: 3, adminCount: 1, papel: "dono", isAnnounce: false, tipo: "comunidade" }])).toEqual([
      { chatId: "4@g.us", subject: "P", participantCount: 3, adminCount: 1, papel: "dono", isAnnounce: false, tipo: "comunidade" },
    ]);
  });
});

describe("canal Verdash: grupo, chamada ao número (9224)", () => {
  /** Dublê com sessão (telefone + metadata), mensagens outbound conhecidas e registro de updates. */
  function adminComSessao(opts: { outbound?: string[]; metadata?: Record<string, unknown> } = {}) {
    const updates: unknown[] = [];
    const from = vi.fn((tabela: string) => {
      const f: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { f[c] = v; return q; },
        limit: async () => ({ data: tabela === "messages" && (opts.outbound ?? []).includes(String(f.external_id)) ? [{ id: "m" }] : [] }),
        maybeSingle: async () => ({ data: { phone_number: "+5566999990000", metadata: { outra: 1, ...opts.metadata } }, error: null }),
        update: (v: unknown) => { updates.push(v); return q; },
      };
      return q;
    });
    return { rpc: vi.fn(), from, updates };
  }
  const chamadaGravada = () => (gravar.mock.calls[0]![1] as { chamada: boolean }).chamada;

  it("aprende o own_lid na mensagem IsFromMe com Sender @lid, pela função atômica (nunca regrava o metadata)", async () => {
    gravar.mockResolvedValue("gravada");
    const a = adminComSessao();
    await entrada(payload({ conversation: "oi" }, { IsFromMe: true, Sender: "98765432100:4@lid" }), a as never);
    expect(a.updates).toEqual([]);
    expect(a.rpc).toHaveBeenCalledWith("fn_gravar_own_lid", {
      p_organization_id: "org-1",
      p_channel_session_id: "sess-1",
      p_lid: "98765432100",
    });
  });

  it("menção por LID aprendido chama; sem LID aprendido, só a resposta à mensagem do número", async () => {
    gravar.mockResolvedValue("gravada");
    const msg = { extendedTextMessage: { text: "@x oi", contextInfo: { stanzaId: "ABC", mentionedJid: ["98765432100@lid"] } } };
    await entrada(payload(msg), adminComSessao({ metadata: { own_lid: "98765432100" } }) as never);
    expect(chamadaGravada()).toBe(true);

    gravar.mockClear();
    await entrada(payload(msg), adminComSessao() as never);
    expect(chamadaGravada()).toBe(false);

    gravar.mockClear();
    await entrada(payload(msg), adminComSessao({ outbound: ["ABC"] }) as never);
    expect(chamadaGravada()).toBe(true);
  });
});
