/**
 * Cassio, #518: o degrau A0 (OpenRouter com credencial própria, `origem: "padrao_openrouter"`) leva o
 * `base_url` cadastrado pela organização. O worker só passava pela recusa de destino interno quando a
 * origem era `modelo_da_organizacao`: um `base_url` apontando para a rede interna recebia o áudio e a
 * chave no cabeçalho. Aqui o áudio NÃO pode sair, e o controle mostra que destino público passa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { buildDeriveDeps } from "@/workers/media-derive-worker";
import type { DecisaoDeTranscricao } from "@/lib/messaging/media/escada-de-transcricao";

function depsCom(baseUrlDoDestino: string, chamado: { n: number }) {
  const decisao: DecisaoDeTranscricao = {
    origem: "padrao_openrouter",
    transcriber: {
      transcribe: async () => {
        chamado.n++;
        return "texto";
      },
    },
    motivo: "teste",
    anuncio: { provider: "openrouter", modelId: "openai/whisper-1" },
    baseUrlDoDestino,
  } as DecisaoDeTranscricao;
  const llm: Parameters<typeof buildDeriveDeps>[0] = {
    provider: "openrouter",
    apiKey: "sk-or-teste",
    defaultModel: "openai/gpt-5",
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
    origemDaChave: "credencial_da_organizacao",
  };
  return buildDeriveDeps(llm, decisao, "00000000-0000-0000-0000-0000000000a0", {} as never);
}

describe("A0 da transcrição passa pela recusa de destino interno", () => {
  it("base_url na rede interna: o áudio não sai", async () => {
    const chamado = { n: 0 };
    const deps = depsCom("http://169.254.169.254/v1", chamado);
    await expect(deps.transcriber.transcribe(Buffer.from("a"), "audio/ogg")).rejects.toThrow(
      "transcricao_destino_recusado",
    );
    expect(chamado.n, "o transcriber foi chamado com destino interno").toBe(0);
  });

  it("controle: base_url público chega ao transcriber", async () => {
    const chamado = { n: 0 };
    const deps = depsCom("https://8.8.8.8/api/v1", chamado);
    await deps.transcriber.transcribe(Buffer.from("a"), "audio/ogg");
    expect(chamado.n).toBe(1);
  });
});
