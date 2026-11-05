import { describe, expect, it } from "vitest";

import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

import { deltaDaEtiqueta, MAXIMO_DE_ETIQUETAS, regrasDoMenu } from "./menu-da-conversa";

/**
 * As regras do menu da lista são as do cabeçalho. Cada caso aqui tem o par no
 * comentário do `ConversationHeader` que justifica a condição.
 */
const AGORA = new Date("2026-10-06T12:00:00.000Z");

function regras(extra: Partial<ConversationWithContact> = {}, leitura = false) {
  return regrasDoMenu({
    conversation: { ...conversaDeExemplo.conversation, ...extra } as ConversationWithContact,
    meuUserId: "u1",
    leitura,
    automaticoDaOrg: true,
    agora: AGORA,
  });
}

describe("regrasDoMenu", () => {
  it("sem dono e aberta: assumir sim, liberar e pausar não", () => {
    const r = regras();
    expect(r.assumir).toBe(true);
    expect(r.liberar).toBe(false);
    // Sem dono, assumir já cala o automático: pausar seria o mesmo gesto.
    expect(r.pausar).toBe(false);
    expect(r.fechar).toBe(true);
    expect(r.reabrir).toBe(false);
  });

  it("com dono e automático de pé (rodízio): pausar aparece", () => {
    const r = regras({ assigned_to_user_id: "u2", status: "claimed" });
    expect(r.pausar).toBe(true);
    expect(r.assumir).toBe(false);
  });

  it("minha: liberar, e assumir some", () => {
    const r = regras({ assigned_to_user_id: "u1", status: "claimed" });
    expect(r.liberar).toBe(true);
    expect(r.assumir).toBe(false);
  });

  it("automático calado: devolver aparece (mesmo encerrada)", () => {
    const futuro = new Date(AGORA.getTime() + 3_600_000).toISOString();
    expect(regras({ bot_silenced_until: futuro }).devolver).toBe(true);
    expect(regras({ bot_silenced_until: futuro, status: "closed" }).devolver).toBe(true);
    expect(regras().devolver).toBe(false);
  });

  it("encerrada: reabrir no lugar de fechar; sem transferir nem lembrar", () => {
    const r = regras({ status: "closed" });
    expect(r.fechar).toBe(false);
    expect(r.reabrir).toBe(true);
    expect(r.transferir).toBe(false);
    expect(r.lembrar).toBe(false);
    expect(r.arquivar).toBe(true);
    expect(regras({ status: "archived" }).arquivar).toBe(false);
  });

  it("leitura: nada que grave, só ficha e telefone", () => {
    const r = regras({}, true);
    for (const k of ["assumir", "liberar", "devolver", "pausar", "transferir", "lembrar", "etiquetas", "funil", "tarefa", "fechar", "reabrir", "arquivar"] as const)
      expect(r[k], k).toBe(false);
    expect(r.ficha).toBe(true);
    expect(r.copiarTelefone).toBe(true);
  });

  it("Adicionar tarefa aparece para quem grava, em conversa aberta ou encerrada, e some em leitura", () => {
    expect(regras().tarefa).toBe(true);
    expect(regras({ status: "closed" }).tarefa).toBe(true);
    expect(regras({}, true).tarefa).toBe(false);
  });

  it("grupo não oferece copiar telefone", () => {
    expect(regras({ is_group: true }).copiarTelefone).toBe(false);
  });

  it("lembrete no futuro está ativo; no passado, não", () => {
    expect(regras({ snooze_until: "2026-10-06T13:00:00.000Z" }).lembreteAtivo).toBe(true);
    expect(regras({ snooze_until: "2026-10-06T11:00:00.000Z" }).lembreteAtivo).toBe(false);
  });
});

describe("deltaDaEtiqueta (9045: só o que mudou, nunca a lista inteira)", () => {
  it("tira a que tem, põe a que falta — e não carrega as outras", () => {
    expect(deltaDaEtiqueta(["a", "b"], "a")).toEqual({ remover: ["a"] });
    expect(deltaDaEtiqueta(["a"], "b")).toEqual({ adicionar: ["b"] });
  });

  it("no teto recusa acrescentar, mas deixa tirar", () => {
    const cheias = Array.from({ length: MAXIMO_DE_ETIQUETAS }, (_, i) => `t${i}`);
    expect(deltaDaEtiqueta(cheias, "nova")).toBeNull();
    expect(deltaDaEtiqueta(cheias, "t0")).toEqual({ remover: ["t0"] });
  });
});
