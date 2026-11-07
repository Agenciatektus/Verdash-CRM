import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "izzy_tok") }));
vi.mock("@/lib/channels/historico/rodada-titular", () => ({ titularApagadoNaPagina: vi.fn(async () => false) }));
vi.mock("@/lib/channels/historico/rodada-gravar", () => ({
  garantirContatoEConversa: vi.fn(async () => ({ contactId: "ct", conversationId: "cv" })),
  gravarMensagens: vi.fn(async () => {}),
  atualizarMensagem: vi.fn(async () => {}),
}));
const comportamento = vi.hoisted(() => ({ erro: null as Error | null }));
vi.mock("@/lib/channels/historico/fonte-izzy", () => ({
  criarFonteIzzy: () => ({
    async paginaDeConversas() {
      if (comportamento.erro) throw comportamento.erro;
      return { conversas: [], lidas: 0 }; // lista vazia = fim
    },
  }),
}));

import { FonteAdiada } from "@/lib/channels/historico/comum";
import { rodarUmaRodada } from "@/lib/channels/historico/rodada";

function banco() {
  const linha: Record<string, unknown> = {
    id: "i1",
    organization_id: "o",
    channel_session_id: "s",
    status: "rodando",
    dias: 30,
    cursor: {},
    fonte: "izzy",
    credencial_cifrada: "\\xabc",
  };
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...linha }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        const q = { eq: () => q, select: async () => (Object.assign(linha, patch), { data: [{ id: "i1" }], error: null }) };
        return q;
      },
    }),
  };
  return { admin: admin as never, linha };
}

describe("rodada com fonte Izzy", () => {
  it("concluir zera a credencial", async () => {
    comportamento.erro = null;
    const { admin, linha } = banco();
    expect((await rodarUmaRodada(admin, "i1")).status).toBe("concluida");
    expect(linha.credencial_cifrada).toBeNull();
  });

  it("erro zera a credencial e não grava o token", async () => {
    comportamento.erro = new Error("izzy_500");
    const { admin, linha } = banco();
    expect((await rodarUmaRodada(admin, "i1")).status).toBe("erro");
    expect(linha.credencial_cifrada).toBeNull();
    expect(JSON.stringify(linha)).not.toContain("izzy_tok");
  });

  it("FonteAdiada (429) segue rodando, com a credencial intacta e sem erro", async () => {
    comportamento.erro = new FonteAdiada("izzy_limite");
    const { admin, linha } = banco();
    expect((await rodarUmaRodada(admin, "i1")).status).toBe("rodando");
    expect(linha.status).toBe("rodando");
    expect(linha.credencial_cifrada).toBe("\\xabc");
    expect(linha.erro ?? null).toBeNull();
  });
});
