import { describe, expect, it, vi } from "vitest";

import { aplicarEstadoDeGrupo, ehEventoDeEstado, lerEstadoDeGrupo } from "./estado-de-grupo";

const G = "120363000000000001@g.us";
const evento = (type: string, event: Record<string, unknown>) => ({ type, event });

describe("lerEstadoDeGrupo", () => {
  it("lê os formatos aceitos", () => {
    expect(lerEstadoDeGrupo(evento("Archive", { JID: G, Action: { archived: true } }))).toEqual({ jid: G, archived: true });
    expect(lerEstadoDeGrupo(evento("Archive", { jid: G, Action: { Archived: false } }))).toEqual({ jid: G, archived: false });
    expect(lerEstadoDeGrupo(evento("Pin", { Chat: G, Action: { pinned: true } }))).toEqual({ jid: G, pinned: true });
    expect(lerEstadoDeGrupo(evento("Pin", { Chat: G, Pinned: false }))).toEqual({ jid: G, pinned: false });
  });
  it("formato desconhecido ou chat que não é grupo: null", () => {
    expect(lerEstadoDeGrupo(evento("Archive", { Foo: "bar" }))).toBeNull();
    expect(lerEstadoDeGrupo(evento("Archive", { JID: "5511@s.whatsapp.net", Action: { archived: true } }))).toBeNull();
    expect(lerEstadoDeGrupo(evento("Archive", { JID: G }))).toBeNull();
  });
  it("só Archive e Pin são eventos de estado (AppState cru não é assinado)", () => {
    expect(ehEventoDeEstado({ type: "Pin" })).toBe(true);
    expect(ehEventoDeEstado({ type: "AppState" })).toBe(false);
    expect(ehEventoDeEstado({ type: "Message" })).toBe(false);
  });
});

function admin(achou: boolean) {
  const select = vi.fn(async () => ({ data: achou ? [{ group_chat_id: G }] : [], error: null }));
  const eq3 = { select };
  const eq2 = { eq: vi.fn(() => eq3) };
  const eq1 = { eq: vi.fn(() => eq2) };
  const update = vi.fn(() => ({ eq: vi.fn(() => eq1) }));
  return { client: { from: vi.fn(() => ({ update })) } as never, update };
}

describe("aplicarEstadoDeGrupo", () => {
  const base = { organizationId: "o", channelSessionId: "s" };
  it("atualiza grupo que está no diretório", async () => {
    const { client, update } = admin(true);
    const r = await aplicarEstadoDeGrupo(client, { ...base, payload: evento("Archive", { JID: G, Action: { archived: true } }) });
    expect(r.status).toBe("updated");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ archived: true, archived_changed_at: expect.any(String) }));
  });
  it("grupo fora do diretório: ignora", async () => {
    const { client } = admin(false);
    const r = await aplicarEstadoDeGrupo(client, { ...base, payload: evento("Pin", { JID: G, Action: { pinned: true } }) });
    expect(r).toMatchObject({ status: "ignored", reason: "estado_grupo_fora_do_diretorio" });
  });
  it("formato desconhecido: ignora sem tocar no banco", async () => {
    const { client, update } = admin(true);
    const r = await aplicarEstadoDeGrupo(client, { ...base, payload: evento("Pin", { Sync: { x: 1 } }) });
    expect(r).toMatchObject({ status: "ignored", reason: "estado_formato_desconhecido" });
    expect(update).not.toHaveBeenCalled();
  });
});
