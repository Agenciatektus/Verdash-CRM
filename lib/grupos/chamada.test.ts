import { describe, expect, it } from "vitest";

import { contextoDaMensagem, ehChamada } from "./chamada";

const EU = { phone: "+5566999990000", lid: "123456789012345" };
const SEM_LID = { phone: EU.phone, lid: null };

describe("contextoDaMensagem", () => {
  it("lê o contextInfo de texto, imagem e vídeo, nas duas grafias", () => {
    for (const tipo of ["extendedTextMessage", "imageMessage", "videoMessage"]) {
      const c = contextoDaMensagem({ [tipo]: { contextInfo: { stanzaId: "A1", participant: "9@lid", mentionedJid: ["8@lid"] } } });
      expect(c).toEqual({ citada: "A1", jids: ["9@lid", "8@lid"] });
    }
    expect(contextoDaMensagem({ extendedTextMessage: { contextInfo: { stanzaID: "B", mentionedJID: ["7@lid"] } } })).toEqual({ citada: "B", jids: ["7@lid"] });
  });
  it("não desce na mensagem citada e aceita mensagem sem contexto", () => {
    expect(contextoDaMensagem({ conversation: "oi" })).toEqual({ citada: null, jids: [] });
    expect(contextoDaMensagem({ extendedTextMessage: { text: "x", contextInfo: { quotedMessage: { extendedTextMessage: { contextInfo: { mentionedJid: [`${EU.lid}@lid`] } } } } } }).jids).toEqual([]);
  });
});

describe("ehChamada", () => {
  it("menção por LID e por telefone (com e sem nono dígito, com sufixo de dispositivo)", () => {
    expect(ehChamada({ citada: null, jids: [`${EU.lid}@lid`] }, EU, false)).toBe(true);
    expect(ehChamada({ citada: null, jids: ["5566999990000@s.whatsapp.net"] }, EU, false)).toBe(true);
    expect(ehChamada({ citada: null, jids: ["556699990000:7@s.whatsapp.net"] }, EU, false)).toBe(true);
  });
  it("citar o autor (participant) pelo LID chama", () => {
    expect(ehChamada(contextoDaMensagem({ extendedTextMessage: { contextInfo: { stanzaId: "X", participant: `${EU.lid}@lid` } } }), EU, false)).toBe(true);
  });
  it("mesmo número em OUTRO DDD não chama (o fim igual não basta)", () => {
    expect(ehChamada({ citada: null, jids: ["5511999990000@s.whatsapp.net"] }, EU, false)).toBe(false);
    expect(ehChamada({ citada: null, jids: ["551199990000@s.whatsapp.net"] }, EU, false)).toBe(false);
  });
  it("outra pessoa marcada não chama", () => {
    expect(ehChamada({ citada: "X", jids: ["999@lid", "5511988887777@s.whatsapp.net"] }, EU, false)).toBe(false);
  });
  it("LID ainda não aprendido: só a resposta à mensagem do número aciona", () => {
    expect(ehChamada({ citada: "X", jids: [`${EU.lid}@lid`] }, SEM_LID, false)).toBe(false);
    expect(ehChamada({ citada: "X", jids: [`${EU.lid}@lid`] }, SEM_LID, true)).toBe(true);
  });
});
