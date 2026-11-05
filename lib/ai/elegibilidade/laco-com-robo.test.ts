import { describe, expect, it } from "vitest";

import {
  detectarLacoComRobo,
  normalizarTexto,
  type MensagemDaConversa,
} from "./laco-com-robo";

const agora = new Date("2026-10-28T12:00:00Z");
const msg = (
  direcao: "inbound" | "outbound",
  texto: string,
  minAtras = 1,
): MensagemDaConversa => ({
  direcao,
  texto,
  enviadoEm: new Date(agora.getTime() - minAtras * 60_000),
  enviadaPelaIa: direcao === "outbound",
});
const varias = (n: number, d: "inbound" | "outbound", prefixo = "msg") =>
  Array.from({ length: n }, (_, i) => msg(d, `${prefixo} ${"x".repeat(i)}`, i + 1));

// Alterna saída e entrada: `gapS` = segundos entre a saída e a resposta, 120 s entre as rodadas.
const rodadas = (n: number, gapS: number): MensagemDaConversa[] =>
  Array.from({ length: n }, (_, i) => {
    const t0 = agora.getTime() - (n - i) * 120_000;
    return [
      { direcao: "outbound" as const, texto: `bolha a ${i}`, enviadoEm: new Date(t0), enviadaPelaIa: true },
      { direcao: "outbound" as const, texto: `bolha b ${i}`, enviadoEm: new Date(t0 + 2_000), enviadaPelaIa: true },
      { direcao: "inbound" as const, texto: `oi ${"x".repeat(i)}`, enviadoEm: new Date(t0 + 2_000 + gapS * 1000), enviadaPelaIa: false },
    ];
  }).flat();

describe("volume", () => {
  it("URA que responde em segundos (16 bolhas da IA + 12 entradas) dispara", () => {
    expect(detectarLacoComRobo(rodadas(12, 3), agora)).toEqual({ laco: true, motivo: "volume" });
  });
  it("cliente de verdade, mesmo volume, respondendo em minutos NÃO dispara", () => {
    expect(detectarLacoComRobo(rodadas(12, 60), agora)).toEqual({ laco: false, motivo: null });
  });
  it("borda: 15 s conta como máquina, 16 s não", () => {
    expect(detectarLacoComRobo(rodadas(12, 15), agora).laco).toBe(true);
    expect(detectarLacoComRobo(rodadas(12, 16), agora).laco).toBe(false);
  });
  it("robô lento (60 s) escapa da regra rápida, mas o teto de volume pega", () => {
    expect(detectarLacoComRobo(rodadas(20, 60), agora)).toEqual({ laco: true, motivo: "volume" });
  });
  it("só 8 entradas (abaixo de 12) não dispara, mesmo rápidas", () => {
    expect(detectarLacoComRobo(rodadas(8, 3), agora).laco).toBe(false);
  });
  it("só IA, sem cliente, não dispara", () => {
    expect(detectarLacoComRobo(varias(30, "outbound"), agora).laco).toBe(false);
  });
  it("conversa normal com 5 trocas não é afetada", () => {
    const m = [...varias(5, "outbound"), ...varias(5, "inbound", "pergunta")];
    expect(detectarLacoComRobo(m, agora)).toEqual({ laco: false, motivo: null });
  });
  it("mensagens fora da janela de 60 min não contam", () => {
    const velhas = [...varias(16, "outbound"), ...varias(12, "inbound", "oi")].map((m) => ({
      ...m,
      enviadoEm: new Date(agora.getTime() - 120 * 60_000),
    }));
    expect(detectarLacoComRobo(velhas, agora).laco).toBe(false);
  });
});

describe("repeticao", () => {
  const menu = "Digite 1 para falar com o atendimento";
  it("3 entradas iguais com >= 20 chars dispara", () => {
    const r = detectarLacoComRobo([msg("inbound", menu, 1), msg("inbound", menu, 2), msg("inbound", menu, 3), ...varias(3, "outbound")], agora);
    expect(r).toEqual({ laco: true, motivo: "repeticao" });
  });
  it("ciclo de 3 textos distintos x 4 repetições dispara", () => {
    const textos = [menu, "Opção indisponível no momento, tente depois", "Seu protocolo é 123 foi registrado"];
    const m = Array.from({ length: 12 }, (_, i) => msg("inbound", textos[i % 3]!, i + 1));
    expect(detectarLacoComRobo([...m, ...varias(3, "outbound")], agora).motivo).toBe("repeticao");
  });
  it("humano repetindo sem a IA responder não dispara", () => {
    const m = [1, 2, 3].map((i) => msg("inbound", menu, i));
    expect(detectarLacoComRobo(m, agora).laco).toBe(false);
  });
  it("2 iguais não dispara", () => {
    expect(detectarLacoComRobo([msg("inbound", menu, 1), msg("inbound", menu, 2), ...varias(3, "outbound")], agora).laco).toBe(false);
  });
  it("texto curto repetido não dispara", () => {
    const ok = [1, 2, 3, 4].map((i) => msg("inbound", "ok", i));
    expect(detectarLacoComRobo([...ok, ...varias(3, "outbound")], agora).laco).toBe(false);
  });
  it("protocolo com número diferente, acento e caixa viram o mesmo texto", () => {
    const m = [
      msg("inbound", "Seu protocolo é 123456. Aguarde atendimento!", 1),
      msg("inbound", "seu protocolo e 987. aguarde atendimento", 2),
      msg("inbound", "SEU PROTOCOLO É 55 - Aguarde  atendimento.", 3),
    ];
    expect(detectarLacoComRobo([...m, ...varias(3, "outbound")], agora).motivo).toBe("repeticao");
    expect(normalizarTexto("Olá, 12!")).toBe("ola");
  });
});

describe("ura", () => {
  // Salão Fabiana, 04/11: a URA da Light, com a IA respondendo 7 vezes em 5 min.
  const luz = [
    msg("inbound", "Olá! Eu sou a *Lia*, a assistente virtual da *Light* ⚡. Estou falando com Fabiana?", 5),
    msg("outbound", "Este é o WhatsApp do Salão Fabiana Lopes.", 4),
    msg("inbound", "Hmm... Não entendi o que você digitou. Por favor, digite uma das opções que te apresentei", 3),
  ];
  it("duas frases típicas de URA silenciam, mesmo com pouco volume", () => {
    expect(detectarLacoComRobo(luz, agora)).toEqual({ laco: true, motivo: "ura" });
  });
  it("uma frase só não silencia (pode ser citação do cliente)", () => {
    expect(detectarLacoComRobo(luz.slice(0, 2), agora).laco).toBe(false);
  });
  it("cliente de verdade perguntando por atendente não dispara", () => {
    const m = [msg("inbound", "Você ainda está por aí? Preciso agendar", 2), msg("inbound", "Quero falar com uma atendente", 1)];
    expect(detectarLacoComRobo(m, agora).laco).toBe(false);
  });
  it("sinal fora da janela de 60 min não conta", () => {
    const velhas = luz.map((m) => ({ ...m, enviadoEm: new Date(agora.getTime() - 120 * 60_000) }));
    expect(detectarLacoComRobo(velhas, agora).laco).toBe(false);
  });
});
