/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
import type { TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /**
   * Medição devolvida pelo fornecedor. O modelo de conversa traz tokens;
   * o serviço OpenRouter pode trazer o custo em USD, convertido para centavos.
   * Ausência de custo continua null, nunca uma estimativa de preço.
   */
  transcribeMedindo?(audio: Buffer, mime: string): Promise<{ texto: string; uso: TokenUsage }>;
  /**
   * O serviço `/v1/audio/transcriptions` (degraus 1 e 2): sem tokens, mas com o
   * custo que a RESPOSTA traz (`custoDaTranscricao`). `costCents` null = a
   * resposta não deu custo nem duração com preço conhecido.
   */
  transcribeComCusto?(audio: Buffer, mime: string): Promise<{ texto: string; costCents: number | null }>;
}

/**
 * USD por MINUTO de áudio, por id de modelo (prefixo `provider/` tolerado).
 * Só para ESTIMAR quando a resposta traz a duração e não o custo. Fonte:
 * developers.openai.com/api/docs/pricing (whisper-1, US$ 0,006/min). Modelo
 * fora daqui fica sem estimativa: null, nunca um preço emprestado.
 */
const USD_POR_MINUTO_DE_TRANSCRICAO: Record<string, number> = {
  "whisper-1": 0.006,
};

/**
 * O custo, em centavos de DÓLAR, que a resposta de `/v1/audio/transcriptions`
 * permite afirmar — na ordem do mais confiável ao menos:
 *
 *  1. `usage.cost` (dólares) — o OpenRouter devolve o valor COBRADO. É o caso
 *     de produção (`TRANSCRIPTION_BASE_URL=https://openrouter.ai/api/v1`).
 *  2. Duração (`usage.seconds`, que a OpenAI devolve com `type: "duration"`,
 *     ou `duration` do `verbose_json`) × preço por minuto do modelo, quando o
 *     modelo está em `USD_POR_MINUTO_DE_TRANSCRICAO`.
 *  3. null — preço desconhecido. Nunca 0: diria "grátis" ao teto.
 *
 * `usage.cost` acima de `TETO_DE_SANIDADE_USD` por transcrição é tratado como
 * dado corrompido do fornecedor: vira null com aviso no log, em vez de estourar
 * o teto da empresa por um número falso. US$ 0,10 porque a trava de duração
 * (`trava-da-transcricao.ts`) não deixa sair áudio acima de 10 min, e 10 min no
 * whisper-1 custam US$ 0,06 — um valor acima disso não é preço de áudio de
 * WhatsApp. Era US$ 5, o que deixava passar como "real" um custo 80× maior.
 */
export const TETO_DE_SANIDADE_USD = 0.1;

export function custoDaTranscricao(model: string, resposta: unknown): number | null {
  const r = (resposta ?? {}) as { usage?: { cost?: unknown; seconds?: unknown }; duration?: unknown };
  const custoUsd = r.usage?.cost;
  if (typeof custoUsd === "number" && Number.isFinite(custoUsd) && custoUsd >= 0) {
    if (custoUsd > TETO_DE_SANIDADE_USD) {
      // Só o modelo e o valor: nada do áudio nem da transcrição (PII).
      logger.warn("transcrição: usage.cost acima do limite de sanidade, gravado como null", {
        model,
        custo_usd: custoUsd,
        limite_usd: TETO_DE_SANIDADE_USD,
      });
      return null;
    }
    return custoUsd * 100;
  }
  const segundos =
    typeof r.usage?.seconds === "number" ? r.usage.seconds : typeof r.duration === "number" ? r.duration : null;
  const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const porMinuto = USD_POR_MINUTO_DE_TRANSCRICAO[id];
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0 || porMinuto === undefined) return null;
  return (segundos / 60) * porMinuto * 100;
}

/**
 * Os degraus da escada que chamam `/v1/audio/transcriptions` (abaixo). Esse
 * serviço não devolve tokens; o custo vem da resposta quando ela o traz
 * (`custoDaTranscricao`: `usage.cost` do OpenRouter, ou duração × preço por
 * minuto conhecido) e fica nulo quando não traz. É por esta lista — gravada em
 * `origem_da_escolha` — que o aviso de "preço desconhecido" separa esse nulo
 * esperado do degrau 3, que é LLM cobrado por token (`lib/ai/budget/check.ts`).
 */
export const ORIGENS_DA_TRANSCRICAO_POR_SERVICO = [
  "servico_da_instalacao",
  "padrao_openai_compativel",
  "padrao_openrouter",
] as const;

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Idiomas esperados no áudio (ISO-639-1). Vazio = o serviço detecta sozinho,
   * que é o comportamento de sempre.
   *
   * Existe porque a detecção sozinha ALUCINA em áudio curto, com ruído ou com
   * sotaque regional. Medido numa loja em espanhol (26/09/2026, 14 áudios
   * reais de clientes): `whisper-1` sem idioma devolveu "Thanks for
   * watching!" para um áudio sem fala, uma frase em GREGO para "mejor dejamos
   * ahí nomás" (o cliente cancelando) e "ya es claro" para "ya es caro" — e o
   * agente respondeu ao que leu. Com o idioma declarado, `gpt-transcribe`
   * acertou os três e devolveu vazio para o áudio sem fala.
   */
  languages?: readonly string[];
  /**
   * Cabeçalhos EXTRA da chamada, por cima do `Authorization` (#3382: os de
   * atribuição da OpenRouter, `HTTP-Referer`/`X-Title`, que a própria
   * OpenRouter documenta como opcionais). Nulo/ausente = só o Authorization de
   * sempre; o Authorization NUNCA é sobrescrevível por aqui.
   */
  headers?: Record<string, string> | undefined;
  /** Contrato do fornecedor, sem alterar o teto global de mídia. */
  maxAudioBytes?: number;
}

export class TranscriptionTooLargeError extends Error {
  override readonly name = "transcription_audio_too_large";
  constructor(readonly limitBytes: number) {
    super("transcription_audio_too_large");
  }
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

/**
 * O modelo que transcreve de verdade: o de `TRANSCRIPTION_MODEL` quando a
 * instalação o define, senão `whisper-1`. Uma função só para o worker (que
 * transcreve) e a tela de Provedores (que ANUNCIA o modelo) — duas leituras
 * separadas fariam a tela dizer `whisper-1` com outro modelo em uso.
 *
 * Com `TRANSCRIPTION_BASE_URL` preenchido e sem `TRANSCRIPTION_API_KEY`, o
 * modelo do `.env` foi escrito para OUTRO serviço (o exemplo do `.env.example`
 * é `whisper-large-v3`, do Groq), e a chamada vai à OpenAI com a chave da
 * organização: pedir esse modelo lá quebraria no update uma transcrição que
 * funciona com `whisper-1`. Nesse caso vale `whisper-1`, como antes.
 */
export function modeloDeTranscricaoEmVigor(doAmbiente: {
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}): string {
  const m = (doAmbiente.model ?? "").trim();
  const modeloDeOutroServico = (doAmbiente.baseUrl ?? "").trim() !== "" && (doAmbiente.apiKey ?? "").trim() === "";
  return m === "" || modeloDeOutroServico ? DEFAULT_MODEL : m;
}

/**
 * `TRANSCRIPTION_LANGUAGES` ("es" ou "pt,es") → lista de códigos. Tolerante de
 * propósito: é variável opcional de `.env`, e grafia errada não pode derrubar
 * o worker — o código que não tem forma de ISO-639 fica de fora e o resto vale.
 */
export function idiomasDaTranscricao(bruto: string | undefined): string[] {
  return (bruto ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[a-z]{2,3}$/.test(x));
}

/**
 * Como o idioma vai no corpo, conforme o modelo. Os modelos novos da OpenAI
 * (`gpt-transcribe`, `gpt-live-transcribe`) recebem a LISTA `languages[]`; os
 * anteriores (`whisper-1`, `gpt-4o-*-transcribe`, os Whisper de terceiros)
 * recebem UM `language`. Mandar os dois é recusado pela API.
 */
export function camposDeIdioma(model: string, languages: readonly string[]): [string, string][] {
  if (languages.length === 0) return [];
  return /^gpt-(live-)?transcribe\b/.test(model)
    ? languages.map((l): [string, string] => ["languages[]", l])
    : [["language", languages[0]!]];
}

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const rawBase = (creds.baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  const base = rawBase.replace(/\/v1$/, "");
  const model = creds.model ?? DEFAULT_MODEL;
  const transcribeComCusto: NonNullable<TranscriptionProvider["transcribeComCusto"]> = async (audio, mime) => {
    if (creds.maxAudioBytes !== undefined && audio.byteLength > creds.maxAudioBytes) {
      throw new TranscriptionTooLargeError(creds.maxAudioBytes);
    }
    const form = new FormData();
    form.append("model", model);
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
      `audio.${extFor(mime)}`,
    );
    for (const [campo, valor] of camposDeIdioma(model, creds.languages ?? [])) form.append(campo, valor);
    const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { ...creds.headers, Authorization: `Bearer ${creds.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`transcription_${res.status}`);
    const json = (await res.json()) as { text?: string };
    return { texto: json.text ?? "", costCents: custoDaTranscricao(model, json) };
  };
  return {
    transcribe: async (audio, mime) => (await transcribeComCusto(audio, mime)).texto,
    transcribeComCusto,
  };
}
