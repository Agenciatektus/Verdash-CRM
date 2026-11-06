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
    expect(a.from).not.toHaveBeenCalled();
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
    expect(a.from).not.toHaveBeenCalled();
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
    expect(gruposDaLista([{ JID: "1-2@g.us", Name: "Equipe" }, { JID: "5511@s.whatsapp.net", Name: "p" }])).toEqual([
      { chatId: "1-2@g.us", subject: "Equipe" },
    ]);
    expect(gruposDaLista({ Groups: [{ JID: "9@g.us", Name: " " }] })).toEqual([{ chatId: "9@g.us", subject: null }]);
    expect(gruposDaLista([{ chatId: "7@g.us", subject: "Vendas" }])).toEqual([{ chatId: "7@g.us", subject: "Vendas" }]);
    expect(gruposDaLista(null)).toEqual([]);
  });
});
