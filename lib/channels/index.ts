/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { datafyAdapter } from "./adapters/datafy";
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import { instagramAdapter } from "./adapters/instagram";
import { verdashAdapter } from "./adapters/verdash";
import { socialAdapter } from "./social/adapter";
import { zernioAdapter } from "./adapters/zernio";
import type { ChannelAdapter, ChannelProvider, ProviderDeMensagem } from "./types";

/**
 * Um adapter por provider de MENSAGEM. `wacalls` não entra: ele não endereça
 * destinatário nem envia envelope — ver `ProviderDeMensagem` em `./types`.
 */
const ADAPTERS: Record<ProviderDeMensagem, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
  zernio_social: socialAdapter,
  verdash: verdashAdapter,
  /**
   * `null` de propósito: o Instagram APARECE e RECEBE no CRM, mas o envio não sai daqui.
   *
   * O Instagram RESPONDE pelo CRM desde que a plataforma passou a expor o envio
   * ao vínculo pareado (`crm-enviar-instagram`).
   *
   * A trava de resposta pública continua UMA só, e continua no servidor da
   * plataforma — que é o ponto: o adapter daqui usa apenas o Direct, e a
   * operação perigosa nem é oferecida. Duplicar a trava é que criaria a
   * terceira cópia que diverge.
   */
  instagram: instagramAdapter,
  datafy: datafyAdapter,
};

/**
 * Fail-closed: provider sem adapter (ou fora da matriz) lança em vez de cair no
 * WAHA por default. Enviar pelo canal errado é pior que não enviar.
 *
 * Use esta função onde o adapter é OBRIGATÓRIO para a operação seguir (enviar uma
 * mensagem, por exemplo). Onde a ausência é um estado normal — vigiar saúde, baixar
 * mídia, sinalizar digitação — use `getAdapterOpcional`: ver o porquê logo abaixo.
 */
export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = ADAPTERS[provider as ProviderDeMensagem];
  if (!adapter) throw new Error(`unknown_channel_provider: ${provider}`);
  return adapter;
}

/**
 * O adapter, ou `null` quando este código CONHECE o provider e sabe que ele não tem
 * adapter local.
 *
 * ─── POR QUE ESTA SEGUNDA PORTA EXISTE ──────────────────────────────────────
 *
 * Até o Instagram, todo canal ou transportava mensagem E tinha adapter, ou não fazia
 * nenhum dos dois. `getAdapter` lançar era suficiente porque as duas perguntas tinham
 * sempre a mesma resposta.
 *
 * O Instagram é o terceiro caso: RECEBE aqui e responde pelo Verdash. Com só uma porta,
 * `unknown_channel_provider: instagram` passou a ser lançado em três lugares onde a
 * ausência é rotina e não defeito — e em dois deles o `throw` acontecia ANTES do guard
 * que existia justamente para tratar a ausência:
 *
 *   - o vigia de saúde logava erro por sessão a cada rodada, confundindo-se com o
 *     alarme de "imagem desatualizada" que `PROVIDERS_SEM_MENSAGEM` reserva;
 *   - o worker de mídia marcava `failed` numa mídia que apenas não é baixável daqui;
 *   - a sinalização de digitação estourava no caminho de resposta ao cliente.
 *
 * A distinção que esta função devolve é a mesma de `canalConhecidoSemMensagem`:
 * `null` é CATEGORIA, o `throw` é FALHA. Provider fora da matriz continua lançando —
 * o clone que aplicou o baseline antes de puxar a imagem nova precisa fazer barulho.
 */
export function getAdapterOpcional(provider: ChannelProvider): ChannelAdapter | null {
  if (!(provider in ADAPTERS)) throw new Error(`unknown_channel_provider: ${provider}`);
  return ADAPTERS[provider as ProviderDeMensagem];
}

/**
 * O que dizer ao atendente que tenta responder por um canal sem adapter local.
 *
 * Mora aqui, e não no handler de mensagens, porque a frase útil NOMEIA o lugar onde a
 * conversa é respondida — e nome de canal só pode ser escrito em `lib/channels/`
 * (doutrina `restricao-de-canal`, invariante 1). O handler pede o texto e o grava.
 */
const ONDE_RESPONDER: Partial<Record<ProviderDeMensagem, string>> = {
  // Vazio de propósito: todo canal de mensagem desta instalação responde pelo
  // próprio Inbox. A tabela fica porque a pergunta continua valendo para o
  // canal seguinte que entrar sem envio.
};

/** A instrução para o atendente, ou uma genérica quando o canal não declarou a sua. */
export function ondeResponder(provider: ChannelProvider): string {
  return (
    ONDE_RESPONDER[provider as ProviderDeMensagem] ??
    "Este canal não envia mensagens por aqui. Veja na Central de Conexões onde responder."
  );
}

export {
  capabilitiesOf,
  CHANNEL_CAPABILITIES,
  DEFAULT_CHANNEL_PROVIDER,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_SEM_MENSAGEM,
  canalConhecidoSemMensagem,
  transportaMensagem,
} from "./capabilities";
export { canalDesligadoNaInstalacao } from "./desligado";
export { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "./session-ref";
export type { ChannelSessionRef } from "./session-ref";
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  ContatoDoAparelho,
  ProviderDeMensagem,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";
