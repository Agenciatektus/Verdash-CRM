// `ehEcoDeEnvioNosso`: a guarda comum (WAHA + Instagram) que separa o eco de um
// envio do PRÓPRIO CRM de uma resposta humana por fora (issue #519 / P1 da #199).
import { describe, expect, it } from "vitest";

import { ehEcoDeEnvioNosso } from "@/lib/channels/eco-de-envio-nosso";

/** Dublê fluente: registra os filtros e devolve as linhas "em voo" dadas. */
function fazerAdmin(linhas: { body: string | null; type: string }[], erro = false) {
  const filtros: unknown[][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "gte"]) {
    q[m] = (...args: unknown[]) => {
      filtros.push([m, ...args]);
      return q;
    };
  }
  q.limit = async () => (erro ? { data: null, error: { message: "x" } } : { data: linhas, error: null });
  return { filtros, admin: { from: () => q } as never };
}

describe("ehEcoDeEnvioNosso", () => {
  it("texto igual a um envio nosso em voo é eco nosso", async () => {
    const { admin, filtros } = fazerAdmin([{ body: " claro, temos sim! ", type: "text" }]);
    expect(await ehEcoDeEnvioNosso(admin, "org", "conv", { corpo: "claro, temos sim!", midia: false })).toBe(true);
    // Só linha NOSSA, na mesma conversa. O `external_id` não é mais filtro de SQL (upstream #3165):
    // "sem id" (em voo) e "id já devolvido" são decididos em código, e o status entra na consulta.
    expect(filtros).not.toContainEqual(["is", "external_id", null]);
    expect(filtros.some(([m, c]) => m === "in" && c === "status")).toBe(true);
    expect(filtros).toContainEqual(["in", "sent_via", ["ai", "user", "automation", "system"]]);
    expect(filtros).toContainEqual(["eq", "conversation_id", "conv"]);
  });

  it("texto diferente (resposta pelo app) NÃO é eco nosso", async () => {
    const { admin } = fazerAdmin([{ body: "outra coisa", type: "text" }]);
    expect(await ehEcoDeEnvioNosso(admin, "org", "conv", { corpo: "claro!", midia: false })).toBe(false);
  });

  it("mídia só casa com envio nosso de MÍDIA em voo, não de texto", async () => {
    expect(
      await ehEcoDeEnvioNosso(fazerAdmin([{ body: "oi", type: "text" }]).admin, "o", "c", { corpo: null, midia: true }),
    ).toBe(false);
    expect(
      await ehEcoDeEnvioNosso(fazerAdmin([{ body: null, type: "image" }]).admin, "o", "c", { corpo: null, midia: true }),
    ).toBe(true);
  });

  it("falha de leitura NÃO vira eco (na dúvida, pausa)", async () => {
    const { admin } = fazerAdmin([], true);
    expect(await ehEcoDeEnvioNosso(admin, "o", "c", { corpo: "x", midia: false })).toBe(false);
  });
});
