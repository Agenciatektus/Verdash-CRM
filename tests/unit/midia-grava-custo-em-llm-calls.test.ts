import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModuloDaImagemParaIa from "@/lib/messaging/media/imagem-para-ia";

import type * as ModuloDoSeam from "@/lib/agent-engine/edge/llm/run-model-call";
import type * as ModuloDeTranscricao from "@/lib/messaging/media/transcription";

/**
 * Visão e transcrição do worker de mídia saíam pagas e não deixavam linha em
 * `llm_calls` — a tabela que a tela de uso, Execuções e o teto de orçamento
 * leem. O que estes casos fixam: chamada que SAIU grava uma linha no ponto
 * certo, com a organização da linha do evento; chamada RECUSADA antes de sair
 * (destino interno, chave da instalação) não grava nada, porque não custou.
 *
 * Mesmo dublê de `midia-base-url-do-binding.test.ts`, mais a captura do insert
 * em `llm_calls`.
 */

const downloadMock = vi.fn();
const llmCallsInsertMock = vi.fn();
const factoryMock = vi.fn(() => "modelo-de-mentira");
const transcribeDoSvcMock = vi.fn(async () => "transcrição de mentira");
/**
 * `undefined` = o serviço só tem `transcribe` (o dublê de sempre). Número ou
 * null = o serviço também tem `transcribeComCusto` e devolve este custo — é
 * o `apiTranscriptionProvider` real, que lê `usage.cost` da resposta.
 */
const servico = vi.hoisted(() => ({ custo: undefined as number | null | undefined }));
const transcribeComCustoMock = vi.fn(async () => ({ texto: "transcrição de mentira", costCents: servico.custo ?? null }));

const dns = vi.hoisted(() => ({ resposta: [] as Array<{ address: string; family: number }> }));
const reducao = vi.hoisted(() => ({ falha: false, saida: null as Buffer | null }));
// A redução da foto (`imagem-para-ia.ts`) tem teste próprio; aqui o buffer é
// de mentira e só importa o que acontece depois dela.
vi.mock("@/lib/messaging/media/imagem-para-ia", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDaImagemParaIa>()),
  // `falha` = o sharp não reduziu (binário ausente, arquivo que não decodifica).
  // `saida` = o que a redução devolve; null = o próprio buffer (pass-through).
  reduzirImagemParaIa: async (b: Buffer) =>
    reducao.falha ? null : { buffer: reducao.saida ?? b, mime: "image/jpeg" as const },
}));

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => dns.resposta);
  return { lookup, default: { lookup } };
});

const BINDING = {
  provider: "anthropic",
  model_id: "claude-haiku-4-5",
  credential_id: "cred-1",
  base_url: null as string | null,
};
let bindingDaVez: typeof BINDING | null = BINDING;

let linhaDaMensagem = {
  id: "msg1",
  organization_id: "org1",
  type: "image" as string,
  media_mime: "image/jpeg",
  media_storage_path: "org1/conv1/msg1.jpg",
  media_derived_status: null as string | null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings" ? bindingDaVez : tabela === "agent_inbox_items" ? null : linhaDaMensagem;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "llm_calls") llmCallsInsertMock(row);
          return { error: null };
        },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "derivado de mentira"),
}));

const credencial = vi.hoisted(() => ({
  origemDaChave: "credencial_da_organizacao" as "credencial_da_organizacao" | "chave_da_instalacao",
  /**
   * `null` = a conversa é a Anthropic de sempre e há chave OpenAI (degrau 2).
   * Preenchido = a conversa é este modelo Google, que declara `audio`, e não há
   * chave OpenAI nenhuma — a escada desce ao degrau 4.
   */
  conversaGoogle: null as string | null,
  /** Provedor+modelo da conversa quando não é Google nem a Anthropic de sempre. */
  conversa: null as { provider: string; model: string } | null,
  /** De quem é a chave OpenAI do degrau 2; null = a mesma `origemDaChave`. */
  origemDaOpenai: null as "credencial_da_organizacao" | "chave_da_instalacao" | null,
  /** A org não tem credencial OpenAI própria: a escada desce ao serviço da instalação. */
  semOpenaiPropria: false,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async (_db: unknown, _cfg: unknown, _org: string, override?: { provider?: string }) => {
    if ((credencial.conversaGoogle || credencial.semOpenaiPropria) && override?.provider === "openai") throw new Error("sem credencial openai");
    const origemDaChave =
      override?.provider === "openai" && credencial.origemDaOpenai ? credencial.origemDaOpenai : credencial.origemDaChave;
    return {
      provider: credencial.conversa?.provider ?? (credencial.conversaGoogle ? "google" : "anthropic"),
      apiKey: "chave-do-binding",
      origemDaChave,
      defaultModel: credencial.conversa?.model ?? credencial.conversaGoogle ?? "claude-haiku-4-5",
      params: {},
      enabledModels: [],
      orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
      orcamentoIndisponivelPorque: null,
    };
  }),
}));

vi.mock("@/lib/agent-engine/edge/llm/providers", () => ({
  createDefaultRegistry: () => ({
    anthropic: factoryMock,
    openai: factoryMock,
    "openai-assinatura": factoryMock,
    openrouter: factoryMock,
    google: factoryMock,
  }),
  // A escada lê estes dois para o degrau OpenRouter (#3382); o mock tem de
  // exportá-los, senão o import do worker morre antes de qualquer caso.
  OPENROUTER_ENDPOINT: "https://openrouter.ai/api/v1",
  cabecalhosDeAtribuicaoOpenRouter: () => undefined,
  fetchDoProvedor: () => globalThis.fetch,
}));

vi.mock("@/lib/ai/pontos/capacidade-em-vigor", () => ({
  visaoEmVigor: vi.fn(async () => ({ enxerga: true, sabemos: true })),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({
    text: "descrição de mentira",
    usage: {
      inputTokens: 1200,
      outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })),
}));

// O gate de orçamento REAL, espiado: os casos de transcrição pelo serviço
// provam que ele é consultado (e que a recusa dele segura o áudio).
const teto = vi.hoisted(() => ({ barrar: false, real: true }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDoSeam>();
  return {
    ...real,
    aplicarOrcamento: vi.fn(async (d: Parameters<typeof real.aplicarOrcamento>[0]) => {
      if (teto.barrar) throw new real.LlmBudgetExceededError("teto de teste");
      // `real: false` = só espiar a entrada: com a chave da instalação o gate de
      // verdade consulta `fn_cobranca_ligada` no pool, que aqui não existe.
      if (!teto.real) return;
      return real.aplicarOrcamento(d);
    }),
  };
});

vi.mock("@/lib/messaging/media/transcription", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDeTranscricao>()),
  apiTranscriptionProvider: () =>
    servico.custo === undefined
      ? { transcribe: transcribeDoSvcMock }
      : { transcribe: transcribeDoSvcMock, transcribeComCusto: transcribeComCustoMock },
}));

const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<{ env: Env }>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_LANGUAGES: "",
      IA_DESTINOS_INTERNOS_PERMITIDOS: "",
    },
  };
});

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { esquecerDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";
import { PONTO_TRANSCRICAO_DE_AUDIO, PONTO_VISAO_DE_IMAGEM } from "@/lib/ai/pontos/registro";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import type { Env } from "@/lib/env";
import { generateText } from "ai";
import { MAX_TOKENS_DA_DESCRICAO_DE_IMAGEM } from "@/lib/messaging/media/imagem-para-ia";
import { MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO } from "@/lib/messaging/media/escada-de-transcricao";

// Fora do assunto deste teste: a instalação serve a org (sem plano com IA própria).
vi.mock("@/lib/cobranca/ia-propria", async (orig) =>
  (await import("@/tests/helpers/ia-propria-instalacao-serve")).instalacaoServeAOrg(await orig()));

function eventRow(org = "org1") {
  return {
    id: "ev1",
    organization_id: org,
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function depsDaChamada(): DeriveDeps {
  const deps = vi.mocked(deriveMediaText).mock.calls[0]?.[3];
  if (!deps) throw new Error("deriveMediaText não recebeu deps: a derivação parou antes");
  return deps;
}

function comAudio(): void {
  linhaDaMensagem = { ...linhaDaMensagem, type: "audio", media_mime: "audio/ogg", media_storage_path: "org1/conv1/msg1.ogg" };
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerDestinosInternos();
  dns.resposta = [{ address: "93.184.216.34", family: 4 }];
  credencial.origemDaChave = "credencial_da_organizacao";
  credencial.conversaGoogle = null;
  credencial.conversa = null;
  credencial.semOpenaiPropria = false;
  servico.custo = undefined;
  teto.barrar = false;
  teto.real = true;
  credencial.origemDaOpenai = null;
  reducao.falha = false;
  reducao.saida = null;
  bindingDaVez = BINDING;
  transcricaoDoEnv.apiKey = "";
  transcricaoDoEnv.baseUrl = "";
  linhaDaMensagem = {
    id: "msg1",
    organization_id: "org1",
    type: "image",
    media_mime: "image/jpeg",
    media_storage_path: "org1/conv1/msg1.jpg",
    media_derived_status: null,
  };
  downloadMock.mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null });
});

describe("worker de mídia: chamada paga grava em llm_calls", () => {
  it("visão que saiu grava uma linha no ponto da visão, com tokens e custo da tabela de preços", async () => {
    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).toHaveBeenCalled();
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_VISAO_DE_IMAGEM,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      input_tokens: 1200,
      output_tokens: 40,
      status: "ok",
    });
    // haiku-4-5: 1 USD/MTok de entrada, 5 de saída → (1200×1 + 40×5)/1e6 USD
    expect(linha.cost_cents).toBeCloseTo(((1200 * 1 + 40 * 5) / 1_000_000) * 100, 10);
    expect(typeof linha.latency_ms).toBe("number");
  });

  it("visão recusada por destino interno não grava linha", async () => {
    bindingDaVez = { ...BINDING, base_url: "http://169.254.169.254/v1" };

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("visão recusada por endereço da empresa com chave da instalação não grava linha", async () => {
    credencial.origemDaChave = "chave_da_instalacao";
    bindingDaVez = { ...BINDING, base_url: "https://gateway.publico.exemplo/v1" };

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("transcrição que saiu grava uma linha no ponto do áudio, com custo desconhecido (null, nunca 0)", async () => {
    comAudio();

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).toHaveBeenCalled();
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      provider: "openai",
      model: "whisper-1",
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: null,
      status: "ok",
    });
  });

  it("transcrição pelo serviço grava o degrau da escada, que é o que a separa do furo de medição", async () => {
    comAudio();

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({ origem_da_escolha: "padrao_openai_compativel" });
  });

  // Os casos do degrau OpenRouter do upstream (#3382, `transcribeMedindo`) saíram: aqui o A0
  // usa o mesmo `apiTranscriptionProvider` dos outros degraus, com custo por `transcribeComCusto`.

  it("transcrição pelo modelo da organização (degrau 4) grava tokens e o custo da tabela de preços", async () => {
    comAudio();
    credencial.conversaGoogle = "gemini-2.5-flash";
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    // O áudio foi ao MODELO, não ao serviço de transcrição.
    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(texto).toBe("descrição de mentira");
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      provider: "google",
      model: "gemini-2.5-flash",
      origem_da_escolha: "modelo_da_organizacao",
      input_tokens: 1200,
      output_tokens: 40,
      status: "ok",
    });
    // gemini-2.5-flash: 0,30 USD/MTok de entrada, 2,50 de saída
    expect(linha.cost_cents).toBeCloseTo(((1200 * 0.3 + 40 * 2.5) / 1_000_000) * 100, 10);
  });

  it("degrau 4 com modelo fora da tabela de preços grava os tokens e custo null — nunca 0", async () => {
    comAudio();
    credencial.conversaGoogle = "gemini-modelo-que-ninguem-precificou";
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      origem_da_escolha: "modelo_da_organizacao",
      input_tokens: 1200,
      cost_cents: null,
    });
  });

  it("transcrição recusada por destino interno não grava linha", async () => {
    comAudio();
    credencial.semOpenaiPropria = true;
    transcricaoDoEnv.apiKey = "chave-do-servico";
    transcricaoDoEnv.baseUrl = "http://169.254.169.254/v1";

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("transcrição que falha no provedor grava a linha de erro e o erro continua subindo", async () => {
    comAudio();
    transcribeDoSvcMock.mockRejectedValueOnce(new Error("transcription_401"));

    await deriveMessageMedia(eventRow());
    await expect(depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg")).rejects.toThrow(
      "transcription_401",
    );

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      status: "erro",
      cost_cents: null,
      input_tokens: 0,
    });
    expect(String(linha.error_message)).toContain("transcription_401");
    expect(typeof linha.error_code).toBe("string");
  });

  it("visão que falha no provedor grava a linha de erro e o erro continua subindo", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockRejectedValueOnce(Object.assign(new Error("invalid x-api-key"), { statusCode: 401 }));

    await deriveMessageMedia(eventRow());
    await expect(depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg")).rejects.toThrow("invalid x-api-key");

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_VISAO_DE_IMAGEM,
      status: "erro",
      cost_cents: null,
      http_status: 401,
    });
  });
});

describe("custo da transcrição pelo serviço e da assinatura (21/10/2026)", () => {
  it("⭐ degrau 2 com custo na resposta grava esse custo na linha da organização da mensagem", async () => {
    comAudio();
    // O caminho do objeto tem de ser da org da mensagem: o worker recusa
    // `invalid_media_path` antes de derivar (upstream 1.95).
    linhaDaMensagem = { ...linhaDaMensagem, organization_id: "org2", media_storage_path: "org2/conv1/msg1.ogg" };
    servico.custo = 0.12;

    await deriveMessageMedia(eventRow("org2"));
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeComCustoMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org2",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      origem_da_escolha: "padrao_openai_compativel",
      cost_cents: 0.12,
      status: "ok",
    });
  });

  it("degrau 1 pelo OpenRouter grava provider `openrouter` e o custo devolvido", async () => {
    comAudio();
    credencial.semOpenaiPropria = true;
    transcricaoDoEnv.apiKey = "sk-or-da-instalacao";
    transcricaoDoEnv.baseUrl = "https://openrouter.ai/api/v1";
    servico.custo = 0.05;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org1",
      provider: "openrouter",
      origem_da_escolha: "servico_da_instalacao",
      cost_cents: 0.05,
    });
  });

  it("controle negativo: resposta sem custo grava null, nunca 0", async () => {
    comAudio();
    servico.custo = null;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeComCustoMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({ cost_cents: null, status: "ok" });
  });

  it("degraus 1 e 2 passam pelo teto de gasto, na organização certa", async () => {
    const { aplicarOrcamento } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    comAudio();
    servico.custo = 0.12;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(vi.mocked(aplicarOrcamento)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aplicarOrcamento).mock.calls[0]![0]).toMatchObject({
      organizationId: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      origem: "padrao_openai_compativel",
    });
  });

  it("⭐ degrau 1 com credencial própria na conversa: o teto vê a chave da INSTALAÇÃO", async () => {
    const { aplicarOrcamento } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    comAudio();
    credencial.origemDaChave = "credencial_da_organizacao";
    credencial.semOpenaiPropria = true;
    transcricaoDoEnv.apiKey = "sk-or-da-instalacao";
    transcricaoDoEnv.baseUrl = "https://openrouter.ai/api/v1";
    servico.custo = 0.05;
    teto.real = false;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(vi.mocked(aplicarOrcamento)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aplicarOrcamento).mock.calls[0]![0]).toMatchObject({
      origem: "servico_da_instalacao",
      origemDaChave: "chave_da_instalacao",
    });
  });

  it("a chave OpenAI da INSTALAÇÃO não é degrau da org: o áudio vai ao serviço, último degrau", async () => {
    const { aplicarOrcamento } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    comAudio();
    credencial.origemDaChave = "credencial_da_organizacao";
    credencial.origemDaOpenai = "chave_da_instalacao";
    transcricaoDoEnv.apiKey = "sk-or-da-instalacao";
    teto.real = false;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(vi.mocked(aplicarOrcamento).mock.calls[0]![0]).toMatchObject({
      origem: "servico_da_instalacao",
      origemDaChave: "chave_da_instalacao",
    });
  });

  it("controle negativo: degrau 2 com a chave OpenAI da própria empresa segue `credencial_da_organizacao`", async () => {
    const { aplicarOrcamento } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    comAudio();
    credencial.origemDaChave = "chave_da_instalacao";
    credencial.origemDaOpenai = "credencial_da_organizacao";
    teto.real = false;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(vi.mocked(aplicarOrcamento).mock.calls[0]![0]).toMatchObject({
      origem: "padrao_openai_compativel",
      origemDaChave: "credencial_da_organizacao",
    });
  });

  it("teto barrando segura o áudio no degrau 2: o serviço não é chamado e não sai linha de custo", async () => {
    comAudio();
    servico.custo = 0.12;
    teto.barrar = true;

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(texto).toBe(MARCADOR_NAO_LIDA);
    expect(transcribeComCustoMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("⭐ visão pela assinatura grava cost_cents = 0 com os tokens", async () => {
    credencial.conversa = { provider: "openai-assinatura", model: "gpt-6-luna" };
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      provider: "openai-assinatura",
      model: "gpt-6-luna",
      input_tokens: 1200,
      output_tokens: 40,
      cost_cents: 0,
    });
  });

  it("controle negativo: o mesmo modelo pela chave paga grava o preço da tabela", async () => {
    credencial.conversa = { provider: "openai", model: "gpt-6-luna" };
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha.provider).toBe("openai");
    // gpt-6-luna: 0,10 USD/MTok de entrada, 0,50 de saída
    expect(linha.cost_cents).toBeCloseTo(((1200 * 0.1 + 40 * 0.5) / 1_000_000) * 100, 10);
  });
});

describe("custo de mídia: teto de saída e foto reduzida antes de sair", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pedidoAoModelo = () => vi.mocked(generateText).mock.calls[0]![0] as any;

  it("⭐ a visão sai com teto de saída e com a foto REDUZIDA, não com o original", async () => {
    reducao.saida = Buffer.from("foto-reduzida");
    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("foto-original-gigante"), "image/png");

    expect(MAX_TOKENS_DA_DESCRICAO_DE_IMAGEM).toBe(300);
    const pedido = pedidoAoModelo();
    expect(pedido.maxOutputTokens).toBe(MAX_TOKENS_DA_DESCRICAO_DE_IMAGEM);
    const arquivo = pedido.messages[0].content.find((c: { type: string }) => c.type === "file");
    expect(String(arquivo.data)).toBe("foto-reduzida");
    expect(arquivo.mediaType).toBe("image/jpeg");
    // Controle negativo: o original não está em parte nenhuma do pedido.
    expect(JSON.stringify(pedido.messages)).not.toContain("foto-original-gigante");
  });

  it("⭐ redução que falha: a foto NÃO sai, vira não lida e não grava custo", async () => {
    reducao.falha = true;
    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("foto-original-gigante"), "image/jpeg");

    expect(texto).toBe(MARCADOR_NAO_LIDA);
    expect(generateText).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("controle: com a redução funcionando, a mesma foto sai", async () => {
    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("⭐ degrau 3 da transcrição sai com teto de saída proporcional a 10 min de fala", async () => {
    comAudio();
    credencial.conversaGoogle = "gemini-2.5-flash";
    bindingDaVez = null;
    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO).toBe(2_500);
    expect(pedidoAoModelo().maxOutputTokens).toBe(MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO);
  });

  it("controle negativo: o teto de saída da transcrição é maior que o da descrição de imagem", () => {
    // Se alguém trocar uma constante pela outra, 10 min de fala virariam 300 tokens cortados.
    expect(MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO).toBeGreaterThan(MAX_TOKENS_DA_DESCRICAO_DE_IMAGEM);
  });
});

describe("as constantes de purpose da mídia casam com o registro de pontos", () => {
  it("cada uma é o id de uma entrada — senão a linha em llm_calls fica sem rótulo em Execuções", async () => {
    const { PONTO_POR_ID } = await import("@/lib/ai/pontos/registro");
    expect(PONTO_POR_ID.get(PONTO_TRANSCRICAO_DE_AUDIO)?.registraEm).toBe("llm_calls");
    expect(PONTO_POR_ID.get(PONTO_VISAO_DE_IMAGEM)).toBeDefined();
  });
});
