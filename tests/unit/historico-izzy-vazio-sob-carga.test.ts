import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "izzy_tok") }));
vi.mock("@/lib/channels/historico/rodada-titular", () => ({ titularApagadoNaPagina: vi.fn(async () => false) }));
vi.mock("@/lib/channels/historico/rodada-gravar", () => ({
  garantirContatoEConversa: vi.fn(async () => ({ contactId: "ct", conversationId: "cv" })),
  gravarMensagens: vi.fn(async () => {}),
  atualizarMensagem: vi.fn(async () => {}),
}));

import { rodarUmaRodada } from "@/lib/channels/historico/rodada";

const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });

function banco() {
  const linha: Record<string, unknown> = {
    id: "i1", organization_id: "o", channel_session_id: "s", status: "rodando", dias: 30,
    cursor: {}, fonte: "izzy", credencial_cifrada: "\xabc",
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

// Izzy sob carga: a conversa tem prévia, mas /messages devolve sempre lista vazia. Há ainda uma conversa do Instagram (sem telefone).
function izzyVazio() {
  const agora = new Date().toISOString();
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/v1/messages")) return json({ data: [] });
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
    const todas = [
      { id: "c1", last_message_at: agora, last_message_preview: "oi", contact: { phone: "11999999999", name: "A" } },
      { id: "c2", last_message_at: agora, last_message_preview: "oi", contact: { name: "Insta" } },
    ];
    return json({ data: todas.slice(offset), meta: { total: 2 } });
  });
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((f: () => void) => (f(), 0)) as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Izzy devolvendo /messages vazio para sempre", () => {
  it("desiste da conversa depois de 5 adiamentos e conclui, zerando o token", async () => {
    izzyVazio();
    const { admin, linha } = banco();
    let status = "rodando";
    let rodadas = 0;
    while (status === "rodando" && rodadas < 10) {
      status = (await rodarUmaRodada(admin, "i1")).status;
      rodadas += 1;
    }
    expect(status).toBe("concluida");
    expect(rodadas).toBe(6);
    expect(linha.credencial_cifrada).toBeNull();
    expect(linha.mensagens_ignoradas).toBe(1);
    expect((linha.cursor as { semTelefone: { n: number } }).semTelefone.n).toBe(1);
  });
});
