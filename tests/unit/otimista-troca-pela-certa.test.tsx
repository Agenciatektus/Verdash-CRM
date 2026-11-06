import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MENSAGEM REAL SUBSTITUI A SUA PRÓPRIA BOLHA OTIMISTA (P2 do Cassio na #95).
 *
 * A troca comparava só texto e tipo: com a mesma frase enviada duas vezes, a
 * real do SEGUNDO envio levava a bolha do primeiro. Agora o id da bolha
 * otimista viaja como `metadata.client_id` e volta na linha real.
 *
 * Mutante conferido: voltar ao `find` por texto+tipo faz o primeiro caso falhar
 * (some `temp-1`, fica `temp-2`).
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/inbox/cacheDasConversas", () => ({ invalidarListasDaConversa: vi.fn() }));

import { aplicarEventoNaThread } from "@/hooks/inbox/cacheDaThread";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import type { Message } from "@/lib/types/messaging";

const ORG = "org-1";
const CONV = "c-1";
type Thread = InfiniteData<{ data: Message[] }>;

function otimista(id: string, criadaEm: string): Message {
  return {
    id,
    organization_id: "",
    conversation_id: CONV,
    type: "text",
    direction: "outbound",
    body: "ok",
    sent_at: criadaEm,
    created_at: criadaEm,
    metadata: { _optimistic: true, client_id: id },
  } as unknown as Message;
}

function real(id: string, clientId?: string): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    conversation_id: CONV,
    type: "text",
    direction: "outbound",
    body: "ok",
    sent_at: "2026-10-05T12:00:01.000Z",
    created_at: "2026-10-05T12:00:01.000Z",
    metadata: clientId ? { client_id: clientId } : {},
  };
}

let qc: QueryClient;
function semear(msgs: Message[]) {
  qc.setQueryData<Thread>(["messages", CONV], { pages: [{ data: msgs }], pageParams: [null] });
}
function ids(): string[] {
  return qc.getQueryData<Thread>(["messages", CONV])!.pages.flatMap((p) => p.data.map((m) => m.id)).sort();
}

beforeEach(() => {
  qc = new QueryClient();
  post.mockReset();
});

describe("troca da bolha otimista pela real", () => {
  it("dois envios iguais: a real do SEGUNDO leva a bolha do segundo, não a do primeiro", () => {
    semear([otimista("temp-1", "2026-10-05T12:00:00.000Z"), otimista("temp-2", "2026-10-05T12:00:00.500Z")]);
    const r = aplicarEventoNaThread(qc, CONV, ORG, { eventType: "INSERT", new: real("m-2", "temp-2") });
    expect(r).toBe("aplicado");
    expect(ids()).toEqual(["m-2", "temp-1"]);

    aplicarEventoNaThread(qc, CONV, ORG, { eventType: "INSERT", new: real("m-1", "temp-1") });
    expect(ids()).toEqual(["m-1", "m-2"]);
  });

  it("client_id que não é de nenhuma bolha desta aba (mesmo texto de outra aba) não leva bolha nenhuma", () => {
    semear([otimista("temp-1", "2026-10-05T12:00:00.000Z")]);
    aplicarEventoNaThread(qc, CONV, ORG, { eventType: "INSERT", new: real("m-9", "temp-de-outra-aba") });
    expect(ids()).toEqual(["m-9", "temp-1"]);
  });

  it("sem client_id: a mais antiga primeiro (ordem de envio), qualquer que seja a posição no cache", () => {
    semear([otimista("temp-2", "2026-10-05T12:00:00.500Z"), otimista("temp-1", "2026-10-05T12:00:00.000Z")]);
    aplicarEventoNaThread(qc, CONV, ORG, { eventType: "INSERT", new: real("m-1") });
    expect(ids()).toEqual(["m-1", "temp-2"]);
  });

  it("useSendMessage manda o id da bolha otimista como metadata.client_id", async () => {
    semear([]);
    post.mockResolvedValue({ data: real("m-1") });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSendMessage(), { wrapper });
    let idDaBolha = "";
    const espiao = vi.spyOn(qc, "setQueryData").mockImplementationOnce((chave, f) => {
      const r = qc.setQueryData(chave, f as never);
      const bolha = (r as Thread | undefined)?.pages[0]?.data.at(-1);
      idDaBolha = bolha?.id ?? "";
      return r;
    });
    await act(async () => {
      await result.current.mutateAsync({ conversation_id: CONV, body: "ok", metadata: { origem: "teste" } });
    });
    espiao.mockRestore();
    expect(idDaBolha).toMatch(/^temp-/);
    // O 3º argumento é a chave de idempotência do envio (upstream 1.90).
    expect(post).toHaveBeenCalledWith(
      "/api/v1/messages",
      {
        conversation_id: CONV,
        body: "ok",
        metadata: { origem: "teste", client_id: idDaBolha },
      },
      { idempotencyKey: expect.any(String) },
    );
  });
});
