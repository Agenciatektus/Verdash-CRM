/**
 * O ÚNICO lugar do sistema que pode conhecer a diferença entre os canais.
 *
 * Feature nenhuma pergunta *com quem* falamos — pergunta *o que o canal permite*
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Cada capability abaixo
 * nasce de uma diferença real e medida entre WAHA e Meta Cloud; capability que
 * ninguém consome é código morto, e o teste de matriz reprova.
 */
import type { ChannelCapabilities, ChannelProvider, ProviderDeMensagem } from "./types";

export type { ChannelProvider, ChannelCapabilities, ProviderDeMensagem };

/**
 * A matriz descreve o que um canal de MENSAGEM permite — por isso a chave é
 * `ProviderDeMensagem`, não `ChannelProvider`. Perguntar a uma linha de voz se
 * ela manda texto fora da janela de 24h é erro de categoria, e responder
 * qualquer coisa (inclusive tudo `false`) faria a pergunta parecer legítima.
 * `capabilitiesOf` segue falhando fechado para quem não está aqui.
 */
export const CHANNEL_CAPABILITIES: Record<ProviderDeMensagem, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    // Não há WABA por trás: não existe definição aprovada para gerir.
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    alteraMensagemEnviada: true,
    // É a linha que conversa com um APARELHO pareado: a agenda salva no
    // celular está lá dentro, e o `contacts/all` a devolve paginada (#2736).
    phonebook: true,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    // A Graph API cria e edita definições; o repo hoje só ESPELHA, e é essa
    // lacuna que a capability torna visível em vez de deixar implícita.
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // Mesma hetero-restrição do canal oficial, por baixo: é um BSP: a WABA é da
  // Meta, os templates são aprovados pela Meta e a janela de 24h é da Meta. O
  // intermediário muda o TRANSPORTE (quem endereça, como se autentica), não o
  // que o WhatsApp permite — e capability descreve o permitido, não o encanamento.
  //
  // As duas diferenças reais, medidas na doc do provider, não na intuição:
  //
  //  - `voiceNote: "opus-only"`. O provider tem um `voiceNote: true` no envio,
  //    mas exige ogg/opus mono explicitamente e NÃO converte — mesma restrição
  //    do canal oficial. Ler o campo booleano como "ele resolve para mim" é o
  //    erro que manda mp3 e entrega anexo de música.
  //  - `groups: "limited"`. Existe API de grupos, mas só em plano de uso e só
  //    para números fora de coexistência. Capability é o que a instalação MÉDIA
  //    pode fazer; prometer "full" aqui quebraria em quem não paga o plano.
  // `freeformOutsideWindow: false` está MEDIDO, não deduzido. A API aceita o
  // envio livre (200 + wamid) e a Meta recusa a ENTREGA depois, pelo webhook:
  //
  //   131047 Re-engagement message — "The 24-hour customer service window for
  //   this contact is closed. Send an approved template to re-open the
  //   conversation, or wait for the contact to message you first."
  //
  // O detalhe que engana: mandar um template NÃO abre a janela. Só o cliente
  // abre, respondendo. Quem ler o 200 como "enviado" acha que funciona.
  zernio_social: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    voiceNote: "server-convert",
    groups: "none",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  zernio: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },
  // Parceiro homologado pela Meta que espelha a Cloud API (recorte do #1130):
  // a WABA, a janela de 24h e o custo são da Meta. O parceiro muda o TRANSPORTE
  // (host, token), não o que o WhatsApp permite — então o perfil é o do canal
  // oficial.
  //
  // `canManageTemplates: true`: os modelos são os da Cloud API e o parceiro
  // expõe os mesmos endpoints de catálogo; a tela cria e sincroniza por lá.
  // `requiresTemplates: true` porque a regra da Meta é real: fora da janela de
  // 24h, só modelo aprovado passa.
  datafy: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
  },


  /**
   * O WhatsApp comum, por baixo — e por isso IGUAL ao canal por QR, linha por
   * linha. Não é cópia por preguiça: os dois falam com o mesmo whatsmeow, e o
   * que a matriz descreve é o que o WHATSAPP permite, não quem hospeda a
   * conexão. Divergir aqui seria afirmar uma diferença que não existe.
   *
   * As duas que mais enganam quem vem do canal intermediado:
   *
   *  - `voiceNote: "server-convert"`. MEDIDO no OpenAPI do servidor: `ptt: true`
   *    força a conversão para ogg/opus, gera a onda sonora e calcula a duração.
   *    Declarar `opus-only` aqui faria quem prepara a mídia converter de novo,
   *    do lado errado e sem precisar.
   *  - `banRisk: true`. É a contrapartida de não haver WABA: ninguém aprova
   *    template nem cobra por mensagem, e em troca o WhatsApp bane por padrão
   *    de volume. Desarmar o anti-ban aqui poria em risco o número PRINCIPAL do
   *    cliente — que é o mesmo que ele usa na Verdash, não um número de teste.
   */
  verdash: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    // Sem WABA por trás: não existe definição aprovada para gerir.
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    // O adapter do canal hospedado não implementa `editMessage`/apagar para
    // todos: prometer na tela seria oferecer um botão que o envio recusa.
    alteraMensagemEnviada: false,
    phonebook: false,
  },

  /**
   * Instagram — Direct e comentário, roteados pela Verdash.
   *
   * O transporte é o mesmo do `verdash` (a Verdash fala com a Meta), mas as CAPACIDADES
   * não são, e é por isso que ele é provider próprio em vez de uma variante:
   *
   *  - `freeformOutsideWindow: false`. O Instagram tem janela de 24h como o WhatsApp
   *    oficial: fora dela a Meta recusa a mensagem. Declarar `true` aqui faria a tela
   *    deixar o atendente escrever e só descobrir no envio — e o texto se perde.
   *
   *  - `requiresTemplates: false` mesmo com a janela. Não existe template aprovado no
   *    Instagram: fora da janela simplesmente não há como falar, e oferecer "escolher um
   *    template" seria oferecer uma saída que não existe.
   *
   *  - `voiceNote: "none"` e SEM documento. A API de mensagens do Instagram não aceita os
   *    dois. Sem isto a tela mostra o botão de gravar áudio, o atendente grava, e o erro
   *    aparece depois de ele já ter falado.
   *
   *  - `groups: "none"`. Não há grupo no Direct.
   *
   *  - `banRisk: false`. Não é o caso do FZAP: aqui existe app publicado, permissão
   *    concedida pelo dono da conta, e a Meta corta por App Review, não por padrão de
   *    volume. Armar o anti-ban atrasaria resposta sem reduzir risco nenhum.
   *
   *  - `costPerMessage: false`. A Meta não cobra por Direct de Instagram.
   */
  instagram: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: null,
    voiceNote: "none",
    groups: "none",
    costPerMessage: false,
    // Direct não tem edição de mensagem enviada pela API de envio.
    alteraMensagemEnviada: false,
    phonebook: false,
  },
};

/**
 * O que assumir quando o banco NÃO diz qual é o canal — só quando a linha de
 * `channel_sessions` não pôde ser lida (a coluna é `not null default 'waha'`,
 * então uma sessão que existe sempre responde).
 *
 * Espelha o default da coluna de propósito: é o que mantém o comportamento
 * idêntico ao dos literais que as Tasks 4b/5 deixaram no código. E é o canal
 * CONSERVADOR dos dois — banRisk armado, throttle e warm-up ligados; errar para
 * o lado do meta_cloud desarmaria o anti-ban num número que pode ser banido.
 */
export const DEFAULT_CHANNEL_PROVIDER: ChannelProvider = "waha";

/**
 * Constantes nomeadas dos providers. Existem para que nenhum arquivo fora deste
 * módulo precise escrever a string — é o que o `scripts/lint-channels.ts` cobra.
 */
export const CHANNEL_PROVIDER_WAHA: ChannelProvider = "waha";
export const CHANNEL_PROVIDER_META: ChannelProvider = "meta_cloud";
export const CHANNEL_PROVIDER_SOCIAL: ChannelProvider = "zernio_social";
export const CHANNEL_PROVIDER_ZERNIO: ChannelProvider = "zernio";
/** Parceiro que espelha a Cloud API — canal opcional da instalação, desligado por padrão. */
export const CHANNEL_PROVIDER_DATAFY: ChannelProvider = "datafy";
/** Chamada de voz WhatsApp (spec 18). Não transporta mensagem — ver abaixo. */
export const CHANNEL_PROVIDER_WACALLS: ChannelProvider = "wacalls";
/** WhatsApp já conectado na Verdash (FZAP), sem parear de novo. */
export const CHANNEL_PROVIDER_VERDASH: ChannelProvider = "verdash";
/** Instagram (Direct e comentário) roteado pela Verdash. */
export const CHANNEL_PROVIDER_INSTAGRAM: ChannelProvider = "instagram";

/**
 * Os providers por onde MENSAGEM entra e sai — a única lista que responde
 * "este canal serve para conversar?".
 *
 * Existe porque `channel_sessions` deixou de ser só a tabela dos transportes de
 * texto quando a voz entrou nela, e ~39 leituras daquela tabela não filtram
 * provider nenhum: elas dizem "canal" e querem dizer "canal de mensagem". Sem
 * esta lista, uma organização que pareia voz vê a linha de voz virar opção no
 * seletor "Número conectado", nascer amarrada ao primeiro agente publicado,
 * contar como canal conectado no retrato da instalação e ser escolhida por uma
 * automação para mandar texto — por um canal que não manda texto.
 *
 * `satisfies` e não anotação solta: um provider novo que não seja de mensagem
 * precisa ser DECIDIDO aqui, não esquecido.
 */
export const PROVIDERS_DE_MENSAGEM = [
  "waha",
  "meta_cloud",
  "zernio",
  "zernio_social",
  "verdash",
  "instagram",
  "datafy",
] as const satisfies readonly ProviderDeMensagem[];

/**
 * Os providers que alcançam um APARELHO: o endereço é o TELEFONE.
 *
 * É um recorte de `PROVIDERS_DE_MENSAGEM`, e a diferença é a das REDES SOCIAIS
 * (`zernio_social`): o Instagram e o Facebook só falam com quem já escreveu, o
 * contato de lá é outro endereço (handle) e não existe telefone a discar. Quem
 * tem um número na mão e escolhe a sessão social escolheu um canal que NÃO
 * alcança o destino — e o envio fora da janela de 24h é recusado (#3358,
 * medido: "O canal recusou o envio. Confira a conexão em Conexões.").
 *
 * `satisfies` sobre o recorte declara a relação entre as duas listas: um
 * provider que não seja de mensagem não pode entrar aqui, e um provider social
 * que apareça nesta lista reprova em compilação, não em produção.
 */
export const PROVIDERS_DE_TELEFONE = [
  "waha",
  "meta_cloud",
  "zernio",
  "datafy",
] as const satisfies readonly Exclude<(typeof PROVIDERS_DE_MENSAGEM)[number], "zernio_social">[];

/**
 * `true` quando a linha de `channel_sessions` é um canal de mensagem.
 *
 * Aceita `string | null | undefined` de propósito: quem chama está lendo uma
 * coluna do banco, que pode trazer um provider mais novo que este código (um
 * clone que atualizou o schema antes da imagem). Provider desconhecido responde
 * `false` — falhar fechado aqui significa "não use este canal para mandar
 * recado", que é o erro barato; o caro é mandar por um canal que não entrega.
 * A coluna é `not null default 'waha'`, então `null` só aparece quando a linha
 * não pôde ser lida, e aí também não há canal a usar.
 */
export function transportaMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_DE_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * Os providers que ESTE código conhece e que, sabidamente, não conversam.
 *
 * A diferença para `!transportaMensagem(p)` é a que separa "categoria" de
 * "falha", e ela decide o que o vigia de conexão faz com a linha:
 *
 *   - `wacalls` está aqui: ignorar em silêncio é o certo, e um aviso por sessão
 *     de voz a cada minuto seria ruído perpétuo.
 *   - um provider que o CHECK do banco já aceita e esta imagem ainda não conhece
 *     (o clone que aplicou o baseline antes de puxar a imagem nova) NÃO está
 *     aqui — ele tem de fazer barulho, porque uma conexão sem vigia e sem
 *     rastro é exatamente o buraco mudo que ninguém descobre.
 *
 * `transportaMensagem` responde `false` para os dois, e é o que se quer lá: na
 * hora de escolher por onde mandar recado, o desconhecido é tão inútil quanto a
 * voz. Aqui a pergunta é outra.
 */
export const PROVIDERS_SEM_MENSAGEM = ["wacalls"] as const;

/**
 * Erro de COMPILAÇÃO enquanto sobrar provider fora das duas listas. Provider
 * novo obriga a decidir se ele conversa — esquecer não é uma opção disponível.
 */
type ProviderNaoClassificado = Exclude<
  ChannelProvider,
  (typeof PROVIDERS_DE_MENSAGEM)[number] | (typeof PROVIDERS_SEM_MENSAGEM)[number]
>;
const _todoProviderFoiClassificado: ProviderNaoClassificado extends never ? true : never = true;
void _todoProviderFoiClassificado;

/** `true` só para provider conhecido cuja natureza não é mensagem. */
export function canalConhecidoSemMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_SEM_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * Os providers cujo NOME é uma marca que o cliente pronuncia.
 *
 * ─── O QUE ISTO CONSERTA ────────────────────────────────────────────────────
 *
 * `lib/agent-engine/guardrails/vazamento-interno.ts` deriva a lista de vocabulário
 * interno daqui — provider novo entra na cobertura sozinho, que é a decisão certa e
 * está explicada lá. A premissa silenciosa era que nome de provider é nome de
 * encanamento: `waha`, `meta_cloud`, `zernio`, `verdash` — nada que um cliente diga.
 *
 * `instagram` é o primeiro que quebra a premissa. Acrescentá-lo à matriz matriculou a
 * palavra na blocklist, e o agente perdeu a capacidade de dizer o nome do canal que o
 * CRM acabou de ganhar: "vi seu comentário no Instagram", "me chama no Direct",
 * "instagram.com/loja" — tudo virava mensagem calada ou rodada extra de reescrita.
 *
 * A lista mora AQUI e não lá porque nome de provider só pode ser escrito em
 * `lib/channels/` (doutrina `restricao-de-canal`, invariante 1) — e porque a pergunta
 * "este nome é público?" é sobre o canal, não sobre o detector.
 *
 * Critério para entrar: o cliente reconhece e usa a palavra no dia a dia. Na dúvida,
 * NÃO entre — deixar de fora só custa uma reescrita; entrar errado deixa vazar
 * vocabulário interno de verdade.
 */
export const PROVIDERS_DE_MARCA_PUBLICA = [
  "instagram",
] as const satisfies readonly ChannelProvider[];

/**
 * Os nomes de provider que o cliente NÃO deve ver — a matriz menos as marcas públicas.
 * É esta a lista que o detector de vazamento consome.
 */
export const PROVIDERS_DE_NOME_INTERNO: readonly string[] = Object.keys(
  CHANNEL_CAPABILITIES,
).filter((p) => !(PROVIDERS_DE_MARCA_PUBLICA as readonly string[]).includes(p));

/**
 * Como uma CAMPANHA fala por este canal: texto livre (`text`), modelo aprovado
 * (`template`) ou não fala (`null`).
 *
 * Campanha é contato que a empresa inicia — quase sempre fora das 24 horas da
 * última mensagem do cliente. Por isso a pergunta é `freeformOutsideWindow`, e
 * não "aceita texto": o número oficial aceita texto, mas só dentro da janela.
 * Canal que nem manda texto fora da janela nem tem modelo (as redes sociais)
 * não serve para campanha nenhuma.
 *
 * Tolerante como `transportaMensagem`: provider que esta imagem não conhece
 * responde `null` em vez de lançar — a tela de campanha lista conexões, e um
 * throw apagaria a lista inteira.
 */
export function modoDeCampanhaDoCanal(provider: string | null | undefined): "text" | "template" | null {
  if (!transportaMensagem(provider)) return null;
  try {
    const caps = capabilitiesOf(provider as ProviderDeMensagem);
    if (caps.freeformOutsideWindow) return "text";
    if (caps.requiresTemplates) return "template";
    return null;
  } catch {
    return null;
  }
}

/**
 * O canal corre risco de banimento por volume (número por QR)? É o que liga o
 * aquecimento e o teto anti-ban do ritmo. Desconhecido responde `true`: no
 * ritmo, errar para o lado de mandar devagar é o erro barato.
 */
export function canalTemRiscoDeBanimento(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return true;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).banRisk;
  } catch {
    return true;
  }
}

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider as ProviderDeMensagem];
  // Fail-closed: provider fora da matriz não herda o default do WAHA. O tipo
  // barra em compilação; isto barra o que vem do banco em runtime.
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}
