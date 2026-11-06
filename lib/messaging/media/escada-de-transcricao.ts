/**
 * DE ONDE VEM QUEM OUVE O ÁUDIO DO CLIENTE (#2171).
 *
 * O worker de derivação resolvia a transcrição por uma árvore de `if` que só
 * conhecia a OpenAI: sem chave OpenAI em lugar nenhum, o áudio não era
 * transcrito — mesmo para uma organização cujo MODELO DE CONVERSA já entende
 * áudio (Gemini com a chave do Google validada no painel). E o desfecho era
 * mudo: `media_derived_status` ficava nulo, o drain esperava o teto de 8
 * minutos e o turno rodava com a mensagem vazia.
 *
 * Este módulo é a ESCADA, no formato de `lib/ai/embeddings/chave.ts`: degraus
 * do mais específico ao mais genérico, cada um com a razão escrita, e um
 * `null` legítimo no fim que o chamador grava como `failed` + motivo — nunca
 * silêncio, nunca nulo.
 *
 * Ordem desde 26/10/2026 (decisão do dono): tudo o que é da PRÓPRIA organização
 * primeiro; a chave da Tektus (OpenRouter) é a ÚLTIMA opção, para todos. Em
 * produção a chave do serviço da instalação estava morta (401) e, por vir
 * antes, derrubava 195 áudios de clientes que tinham Gemini válido.
 *
 *  A0. **OpenRouter da conversa, com credencial PRÓPRIA** (upstream #3382): o chat
 *     do `@ai-sdk/openai` recusa a parte `audio/ogg` antes de a chamada sair, então
 *     quem conversa pela OpenRouter transcreve na própria OpenRouter
 *     (`/audio/transcriptions`, `openai/whisper-large-v3`), com a mesma chave.
 *  A. **Modelo de conversa da organização que declara `audio`, com credencial
 *     PRÓPRIA** (`origemDaChave = credencial_da_organizacao`): custo zero para
 *     a Tektus. `transcreveAudio` é o registro de capacidades.
 *  B. **Chave OpenAI PRÓPRIA da organização** (BYOK), nunca a da instalação.
 *  C. **Serviço de transcrição da instalação** (`TRANSCRIPTION_API_KEY`): o
 *     último degrau, usado só se A e B não existem ou falham.
 *  D. **Nada** — resposta legítima, com o motivo.
 *
 * ── Queda graciosa ──────────────────────────────────────────────────────────
 * Cada decisão carrega `proxima()`: o degrau válido seguinte, que o worker usa
 * quando o escolhido recusa a chave (401/403). Uma vez por degrau, sem laço.
 *
 * ── Quem ANUNCIA esta escada (#2190) ────────────────────────────────────────
 *
 * A tela de Provedores precisa dizer o MESMO que aqui se decide — e não
 * dizia: o registro fixava `provider: "openai"` / `modelId: "whisper-1"` no
 * ponto, então a organização da #2190 (Gemini, sem conta OpenAI, transcrevendo
 * pelo próprio modelo de conversa) via `whisper-1` na tela, ao lado de um texto
 * dizendo que "exige uma chave desse serviço". Dois caminhos anunciados para um
 * mesmo áudio.
 *
 * Por isso cada degrau devolve, junto do transcriber, o `anuncio` — provider e
 * modelo daquele degrau. A rota do painel roda esta escada e entrega a decisão
 * ao resolvedor (`lib/ai/pontos/resolver.ts`), que é quem fala com o operador:
 * UM lugar decide, os dois lados leem o mesmo lugar, e a régua em
 * `tests/unit/a-tela-e-o-motor-concordam-sobre-imagem.test.ts` compara os dois.
 *
 * Os knobs TRANSCRIPTION_* são lidos pela régua `env` de `lib/env.ts`, nunca
 * pelo `process.env` cru (#855/#964): a guarda de destino do worker
 * (`workers/media-derive-worker.ts`) lê `env.TRANSCRIPTION_BASE_URL`, e duas
 * réguas para o mesmo knob divergem caladas. Teste que precisa variar esses
 * knobs mocka `@/lib/env` (ver `tests/unit/midia-base-url-do-binding.test.ts`).
 */
import { generateText } from "ai";

import { transcreveAudio } from "@/lib/agent-engine/edge/llm/capabilities";
import { MENSAGEM_IA_PROPRIA_SEM_CREDENCIAL } from "@/lib/cobranca/ia-propria";
import {
  OPENROUTER_ENDPOINT,
  cabecalhosDeAtribuicaoOpenRouter,
  createDefaultRegistry,
  fetchDoProvedor,
} from "@/lib/agent-engine/edge/llm/providers";
import { env } from "@/lib/env";

import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";
import {
  apiTranscriptionProvider,
  idiomasDaTranscricao,
  modeloDeTranscricaoEmVigor,
  type ORIGENS_DA_TRANSCRICAO_POR_SERVICO,
} from "@/lib/messaging/media/transcription";

export type OrigemDaTranscricao =
  | (typeof ORIGENS_DA_TRANSCRICAO_POR_SERVICO)[number]
  | "modelo_da_organizacao"
  | "nada";

/** O que o degrau escolhido RODA — e o que a tela pode anunciar. */
export interface AnuncioDaTranscricao {
  /**
   * Provedor/protocolo do degrau. `"openai"` nos degraus 1 e 2 é PROTOCOLO
   * (`/v1/audio/transcriptions`), não a empresa: o degrau 1 aceita outro
   * serviço compatível via `TRANSCRIPTION_BASE_URL`.
   */
  provider: string;
  /**
   * `null` SÓ no degrau `nada`: não há o que anunciar, e a tela diz "—" em vez
   * de prometer um caminho que ninguém vai usar.
   */
  modelId: string | null;
}

/**
 * O porquê de cada desfecho da escada, em frase FIXA. A tela de Provedores
 * mostra este motivo traduzido por `t()`, que casa a frase inteira e não
 * interpola — por isso o modelo não entra no texto (#2205): na tela ele já
 * aparece ao lado, e no worker o log carrega a organização. Toda frase daqui
 * precisa de tradução: `tests/unit/i18n-provedores-e-pontos.test.ts` cobra.
 */
export const MOTIVOS_DA_TRANSCRICAO = {
  servicoDaInstalacao:
    "o serviço de transcrição configurado nesta instalação (TRANSCRIPTION_API_KEY) é o que ouve os áudios",
  chaveOpenai: "a chave OpenAI desta organização usa o padrão de transcrição de sempre",
  modeloDaOrganizacao:
    "o modelo de conversa da organização declara a capacidade audio e transcreve com a própria chave",
  openrouterDaConversa:
    "o provedor de conversa desta organização é a OpenRouter, que transcreve na própria API com a mesma chave",
  semModeloDeConversa:
    "não consegui resolver o modelo de conversa desta organização e não há chave OpenAI para transcrever",
  modeloSemAudio:
    "o modelo de conversa da organização não declara a capacidade audio, e não há chave OpenAI para o serviço de transcrição",
  ninguem: "não há chave OpenAI nem modelo de conversa com capacidade audio nesta organização",
  // Plano com IA própria: a chave da instalação não serve esta empresa.
  iaPropria: MENSAGEM_IA_PROPRIA_SEM_CREDENCIAL,
} as const;

/**
 * O modelo que a OpenRouter transcreve no degrau 3 (#3382), no formato
 * `familia/modelo` que o catálogo dela exige — `whisper-1`, o default dos
 * degraus OpenAI-compatíveis, não existe lá. `openai/whisper-large-v3` é o id
 * que o mantenedor mediu funcionando em `/audio/transcriptions` da própria
 * OpenRouter.
 *
 * Fixo de propósito: `TRANSCRIPTION_MODEL` é o knob do SERVIÇO da instalação
 * (degrau 1), escrito para outro serviço — mandá-lo para a OpenRouter
 * trocaria um modelo que funciona por um id que o catálogo dela não tem.
 */
export const MODELO_DE_TRANSCRICACAO_OPENROUTER = "openai/whisper-large-v3";
/** Multipart oficial: 25 MB. O teto global do Storage continua 50 MiB. */
export const LIMITE_MULTIPART_OPENROUTER_BYTES = 25_000_000;

/** O modelo de CONVERSA da organização, já resolvido pelo worker. */
export interface ConversaDaOrganizacao {
  provider: string;
  apiKey: string | null;
  modelId: string | null;
  baseUrl?: string | null;
  /**
   * A credencial é da PRÓPRIA organização (assinatura/BYOK), e não a chave da
   * instalação? Só `true` habilita o degrau A. Ausente = não é própria.
   */
  credencialPropria?: boolean;
}

export interface DecisaoDeTranscricao {
  origem: OrigemDaTranscricao;
  /** `null` SÓ no degrau "nada" — e aí `motivo` diz por quê. */
  transcriber: TranscriptionProvider | null;
  /**
   * Razoamento em PT-BR, pronto para `metadata.media_derived_motivo`. Sem ele
   * o operador vê `failed` e não sabe o que fazer a seguir.
   */
  motivo: string;
  /** O anúncio fiel do degrau escolhido — a tela repassa ao resolvedor. */
  anuncio: AnuncioDaTranscricao;
  /**
   * O próximo degrau VÁLIDO abaixo deste, para a queda graciosa quando este
   * recusa a chave. `null` = não há. Ausente em `nada`.
   */
  proxima?: () => Promise<DecisaoDeTranscricao | null>;
  /**
   * Endereço (base URL) cadastrado pela organização para o degrau A. O worker
   * passa por `motivoDaRecusaDeDestino` antes de o áudio sair para ele.
   */
  baseUrlDoDestino?: string | null;
}

/** Erro de chave (401/403): justifica descer um degrau E avisar a organização. */
export function chaveRecusadaPeloProvedor(err: unknown): boolean {
  const status = (err as { statusCode?: unknown; status?: unknown } | null) ?? {};
  const codigo = Number(status.statusCode ?? status.status);
  if (codigo === 401 || codigo === 403) return true;
  const msg = err instanceof Error ? err.message : "";
  return /^transcription_(401|403)$/.test(msg);
}

/** O endereço do degrau A foi recusado como destino interno (nada saiu). */
export function destinoRecusado(err: unknown): boolean {
  return err instanceof Error && err.message === "transcricao_destino_recusado";
}

/** Erros que justificam descer um degrau: chave recusada, limite (429), 5xx e tempo esgotado. */
export function podeDescerDeDegrau(err: unknown): boolean {
  if (chaveRecusadaPeloProvedor(err)) return true;
  const e = (err as { statusCode?: unknown; status?: unknown; name?: unknown } | null) ?? {};
  const codigo = Number(e.statusCode ?? e.status);
  if (codigo === 429 || (codigo >= 500 && codigo <= 599)) return true;
  const msg = err instanceof Error ? err.message : "";
  return (
    // Degrau que não existe de fato (provedor sem fábrica, custom sem base URL).
    /custom_provider_sem_base_url|transcription_provider_unavailable|transcricao_destino_recusado/.test(msg) ||
    /^transcription_(429|5\d\d)$/.test(msg) ||
    e.name === "AbortError" ||
    e.name === "TimeoutError" ||
    /timeout|timed out/i.test(msg)
  );
}


/**
 * O pedido ao modelo de conversa. Um PROVEDOR DE TRANSCRIÇÃO como os outros:
 * mesma interface `TranscriptionProvider`, só que o backend é o modelo da
 * organização em vez de `/v1/audio/transcriptions`.
 *
 * O texto pede SÓ a transcrição porque a derivação é camada universal: o
 * derivado vira `media_derived_text` e qualquer modelo de chat lê depois. Um
 * resumo ou uma resposta aqui contaminaria o turno.
 */
function promptDeTranscricao(languages: readonly string[]): string {
  const idioma =
    languages.length > 0
      ? ` O áudio está em ${languages.join(" ou ")} — transcreva nesse idioma.`
      : "";
  return `Transcreva o áudio anexado. Devolva somente o que foi falado, sem comentários, sem rótulos e sem aspas.${idioma}`;
}

/**
 * Teto de SAÍDA da transcrição pelo modelo de conversa (degrau 3). A trava de
 * duração (`trava-da-transcricao.ts`) só deixa sair áudio de até 10 min; 10 min
 * de fala são ~1.500 palavras, ~2.000-2.300 tokens em português. 2.500 cobre o
 * áudio legítimo mais longo e impede que um modelo que desande (repetição,
 * resposta em vez de transcrição) cobre milhares de tokens a mais.
 */
export const MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO = 2_500;

export function transcricaoPeloModelo(modelo: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  languages?: readonly string[];
}): TranscriptionProvider {
  const registry = createDefaultRegistry();
  // É uma chamada de LLM cobrada por token, não um serviço de transcrição: o
  // uso volta junto do texto para o worker gravar tokens e custo.
  const transcribeMedindo: NonNullable<TranscriptionProvider["transcribeMedindo"]> = async (audio, mime) => {
    const factory = registry[modelo.provider];
    if (!factory) {
      // Mesma recusa do resto da cadeia: provedor sem fábrica não transcreve,
      // e a exceção vira `failed` + motivo no worker em vez de texto vazio.
      throw new Error(`transcription_provider_unavailable: ${modelo.provider}`);
    }
    const res = await generateText({
      model: factory(modelo.apiKey, modelo.modelId, modelo.baseUrl ?? undefined),
      maxOutputTokens: MAX_TOKENS_DA_TRANSCRICAO_PELO_MODELO,
      // Sem retentativa interna e com teto de tempo: a cascata é quem desce.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: audio, mediaType: mime.split(";")[0]!.trim() },
            { type: "text", text: promptDeTranscricao(modelo.languages ?? []) },
          ],
        },
      ],
    });
    return {
      texto: (res.text ?? "").trim(),
      uso: {
        inputTokens: res.usage.inputTokens ?? 0,
        outputTokens: res.usage.outputTokens ?? 0,
        cacheReadTokens: res.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: res.usage.inputTokenDetails.cacheWriteTokens ?? 0,
      },
    };
  };
  return {
    transcribe: async (audio, mime) => (await transcribeMedindo(audio, mime)).texto,
    transcribeMedindo,
  };
}

/**
 * A escada. `chaveOpenai` é um DEGRAU com thunk: só é consultado quando um
 * degrau anterior não vale. `de` é o índice por onde recomeçar (queda).
 */
export async function decidirTranscricao(
  entrada: {
    conversa?: ConversaDaOrganizacao | null;
    idiomas?: readonly string[];
    chaveOpenai?: () => Promise<string | null>;
    /**
     * Thunk: a chave da INSTALAÇÃO pode servir esta organização? `false` (plano
     * com IA própria, ou leitura que falhou) pula o degrau C. Ausente = serve,
     * como antes (chamadas sem organização).
     */
    instalacaoServe?: () => Promise<boolean>;
  },
  de = 0,
): Promise<DecisaoDeTranscricao> {
  const idiomas = entrada.idiomas ?? idiomasDaTranscricao(env.TRANSCRIPTION_LANGUAGES);
  const conversa = entrada.conversa;
  const conversaOuve = !!(
    conversa?.apiKey &&
    conversa.modelId &&
    transcreveAudio(conversa.provider, conversa.modelId)
  );
  const pelaConversa = (
    origem: "modelo_da_organizacao",
    motivo: string,
  ): DecisaoDeTranscricao => ({
    origem,
    transcriber: transcricaoPeloModelo({
      provider: conversa!.provider,
      modelId: conversa!.modelId!,
      apiKey: conversa!.apiKey!,
      baseUrl: conversa!.baseUrl ?? null,
      languages: idiomas,
    }),
    motivo,
    baseUrlDoDestino: conversa!.baseUrl ?? null,
    // É ESTE anúncio — e não `whisper-1` — que a tela precisa mostrar quando
    // a organização não tem chave OpenAI (#2190).
    anuncio: { provider: conversa!.provider, modelId: conversa!.modelId! },
  });

  // Memoizado: a pergunta vai ao banco no máximo uma vez por decisão.
  let servePromessa: Promise<boolean> | null = null;
  const instalacaoServe = (): Promise<boolean> =>
    (servePromessa ??= entrada.instalacaoServe ? entrada.instalacaoServe() : Promise.resolve(true));

  const degraus: Array<() => Promise<DecisaoDeTranscricao | null>> = [
    // A0 · OpenRouter da conversa com chave PRÓPRIA (#3382): o chat recusa `audio/ogg`,
    //      então a própria OpenRouter transcreve. Endpoint do painel (ou OPENROUTER_BASE_URL);
    //      o cadastrado passa pela recusa de destino interno do worker (`baseUrlDoDestino`).
    async () => {
      if (!(conversa?.apiKey && conversa.credencialPropria && (conversa.provider ?? "").toLowerCase() === "openrouter")) {
        return null;
      }
      const endpoint = conversa.baseUrl || OPENROUTER_ENDPOINT;
      return {
        origem: "padrao_openrouter",
        transcriber: apiTranscriptionProvider(
          {
            apiKey: conversa.apiKey,
            baseUrl: endpoint,
            model: MODELO_DE_TRANSCRICACAO_OPENROUTER,
            languages: idiomas,
            headers: cabecalhosDeAtribuicaoOpenRouter(),
            maxAudioBytes: LIMITE_MULTIPART_OPENROUTER_BYTES,
          },
          fetchDoProvedor(endpoint),
        ),
        motivo: MOTIVOS_DA_TRANSCRICAO.openrouterDaConversa,
        baseUrlDoDestino: conversa.baseUrl ?? null,
        anuncio: { provider: "openrouter", modelId: MODELO_DE_TRANSCRICACAO_OPENROUTER },
      };
    },
    // A · assinatura/chave PRÓPRIA da organização, no modelo de conversa.
    async () =>
      conversaOuve && conversa!.credencialPropria
        ? pelaConversa("modelo_da_organizacao", MOTIVOS_DA_TRANSCRICAO.modeloDaOrganizacao)
        : null,
    // B · chave OpenAI PRÓPRIA da organização (o worker só entrega a credencial dela).
    async () => {
      const chaveOpenai = entrada.chaveOpenai ? await entrada.chaveOpenai() : null;
      if (!chaveOpenai) return null;
      // A chave PRÓPRIA da org vai para api.openai.com: `openai/whisper-1` é o
      // id do OpenRouter (envs do serviço da instalação) e lá não existe. Com
      // BASE_URL configurada o modelo do .env é de OUTRO serviço: vale whisper-1.
      const modelo = env.TRANSCRIPTION_BASE_URL
        ? "whisper-1"
        : modeloDeTranscricaoEmVigor({ model: env.TRANSCRIPTION_MODEL, apiKey: undefined, baseUrl: undefined });
      return {
        origem: "padrao_openai_compativel",
        transcriber: apiTranscriptionProvider({ apiKey: chaveOpenai, model: modelo, languages: idiomas }),
        motivo: MOTIVOS_DA_TRANSCRICAO.chaveOpenai,
        anuncio: { provider: "openai", modelId: modelo },
      };
    },
    // C · serviço de transcrição da instalação — a chave da Tektus, a última.
    async () => {
      const servico = env.TRANSCRIPTION_API_KEY;
      if (!servico) return null;
      // Plano com IA própria: o serviço da instalação NUNCA ouve esta empresa.
      if (entrada.instalacaoServe && !(await instalacaoServe())) return null;
      // Com a chave do serviço na mão, `modeloDeTranscricaoEmVigor` devolve
      // exatamente o modelo que o transcriber abaixo vai mandar.
      const modelo = modeloDeTranscricaoEmVigor({
        model: env.TRANSCRIPTION_MODEL,
        apiKey: servico,
        baseUrl: env.TRANSCRIPTION_BASE_URL,
      });
      return {
        origem: "servico_da_instalacao",
        transcriber: apiTranscriptionProvider({
          apiKey: servico,
          baseUrl: env.TRANSCRIPTION_BASE_URL || undefined,
          model: env.TRANSCRIPTION_MODEL || undefined,
          languages: idiomas,
        }),
        motivo: MOTIVOS_DA_TRANSCRICAO.servicoDaInstalacao,
        anuncio: { provider: "openai", modelId: modelo },
      };
    },
  ];

  for (let i = de; i < degraus.length; i++) {
    const d = await degraus[i]!();
    if (d) {
      return {
        ...d,
        proxima: async () => {
          const seguinte = await decidirTranscricao(entrada, i + 1);
          return seguinte.transcriber ? seguinte : null;
        },
      };
    }
  }

  // D · Nada — e o motivo é do caso, não um "deu erro" genérico.
  const iaPropriaBloqueou = !!env.TRANSCRIPTION_API_KEY && !!entrada.instalacaoServe && !(await instalacaoServe());
  const motivo = iaPropriaBloqueou
    ? MOTIVOS_DA_TRANSCRICAO.iaPropria
    : !conversa
    ? MOTIVOS_DA_TRANSCRICAO.semModeloDeConversa
    : conversa.modelId && !transcreveAudio(conversa.provider, conversa.modelId)
      ? MOTIVOS_DA_TRANSCRICAO.modeloSemAudio
      : MOTIVOS_DA_TRANSCRICAO.ninguem;
  return {
    origem: "nada",
    transcriber: null,
    motivo,
    // Sem quem transcreva não há modelo a anunciar: `modelId: null` é o que a
    // tela desenha como "—". O `provider` repete o da conversa só como etiqueta.
    anuncio: { provider: conversa?.provider ?? "", modelId: null },
  };
}
