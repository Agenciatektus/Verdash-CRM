import { describe, expect, it } from "vitest";

import { infoDoGrupo, montarChamada } from "./acoes";

const G = "120363025407046714@g.us";

describe("montarChamada", () => {
  it("lista fechada, rota e corpo montados aqui", () => {
    expect(montarChamada({ acao: "qualquer", groupChatId: G })).toBe("acao_invalida");
    expect(montarChamada({ acao: "info", groupChatId: "5511@s.whatsapp.net" })).toBe("grupo_invalido");
    expect(montarChamada({ acao: "info", groupChatId: G })).toEqual({ method: "GET", rota: `/group/info?groupJid=${encodeURIComponent(G)}` });
    expect(montarChamada({ acao: "link", groupChatId: G, reset: true })).toMatchObject({ rota: expect.stringContaining("&reset=true") });
    expect(montarChamada({ acao: "so_admins_enviam", groupChatId: G, ligado: "sim" })).toBe("valor_invalido");
    expect(montarChamada({ acao: "participantes", groupChatId: G, operacao: "promote", telefones: ["+55 21 99999-0000"] })).toEqual({
      method: "POST", rota: "/group/updateparticipants",
      corpo: { groupJid: G, action: "promote", phone: ["5521999990000@s.whatsapp.net"] },
    });
    expect(montarChamada({ acao: "participantes", groupChatId: G, operacao: "ban", telefones: ["5521999990000"] })).toBe("operacao_invalida");
    expect(montarChamada({ acao: "participantes", groupChatId: G, operacao: "add", telefones: ["123"] })).toBe("telefones_invalidos");
    expect(montarChamada({ acao: "nome", groupChatId: G, nome: "  " })).toBe("nome_invalido");
    expect(montarChamada({ acao: "mensagens_temporarias", groupChatId: G, duracao: "1h" })).toBe("duracao_invalida");
    expect(montarChamada({ acao: "mensagens_temporarias", groupChatId: G, duracao: ["24h"] })).toBe("duracao_invalida");
    expect(montarChamada({ acao: "mensagens_temporarias", groupChatId: G, duracao: "7d" })).toEqual({ method: "POST", rota: "/group/ephemeral", corpo: { groupJid: G, duration: "7d" } });
    expect(montarChamada({ acao: "foto", groupChatId: G, imagem: "https://evil.test/x.jpg" })).toBe("foto_invalida");
    expect(montarChamada({ acao: "foto", groupChatId: G, imagem: "data:image/png;base64,iVBORw0KGgo=" })).toBe("foto_invalida");
    expect((montarChamada({ acao: "foto", groupChatId: G, imagem: "data:image/jpeg;base64,/9j/4AAQ" }) as { rota: string }).rota).toBe("/group/photo");
  });
});

describe("infoDoGrupo", () => {
  it("diz se este número é admin", () => {
    const i = infoDoGrupo({ name: "Promo", topic: "Regras", isAnnounce: true, participantCount: 2, participants: [
      { jid: "1@lid", phoneNumber: "5521999990000@s.whatsapp.net", isAdmin: true, displayName: "Loja" },
      { jid: "2@lid", phoneNumber: "5511888887777@s.whatsapp.net", isAdmin: false },
    ] }, "5521999990000");
    expect([i.souAdmin, i.soAdminsEnviam, i.mensagensTemporarias, i.tipo]).toEqual([true, true, "off", "grupo"]);
    expect(i.participantes[1]).toEqual({ telefone: "5511888887777", nome: null, admin: false, dono: false });
  });
  it("número fora da lista: souAdmin null", () => {
    expect(infoDoGrupo({ participants: [] }, "5521999990000").souAdmin).toBeNull();
  });
});
