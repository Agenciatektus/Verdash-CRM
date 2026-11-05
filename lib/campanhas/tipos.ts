/**
 * O vocabulário do módulo de Campanhas — os dois conjuntos de estado e os
 * motivos de exclusão, num lugar só.
 *
 * Os valores são os mesmos do CHECK da migration 0375, estendido pela 0563
 * (`personal`). Quem mudar um lado muda o outro: `tests/invariants/vocabulario-banco-x-typescript.test.ts` varre as
 * colunas que têm CHECK e reprova divergência.
 */

export const STATUS_DA_CAMPANHA = [
  "draft",
  "preparing",
  "ready",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;

export type StatusDaCampanha = (typeof STATUS_DA_CAMPANHA)[number];

/**
 * O que a campanha manda (migration 0710). `text` = corpo livre em
 * `message_body`, para número por QR; `template` = modelo aprovado, para número
 * oficial, que só aceita texto livre dentro das 24 horas da última mensagem do
 * cliente — e campanha fala justamente com quem não escreveu.
 */
export const MODOS_DA_MENSAGEM = ["text", "template"] as const;

export type ModoDaMensagem = (typeof MODOS_DA_MENSAGEM)[number];

/**
 * Em que velocidade a campanha sai (migration 0711). `gradual` = uma mensagem
 * por número a cada rodada do cron (uma por minuto) — a proteção do número por
 * QR e o mais seguro para a qualidade de qualquer número. `rapida` = rajada de
 * várias por segundo, só com modelo aprovado: o número oficial não é banido por
 * volume, quem limita ali é a plataforma (nível diário e mensagens por segundo).
 */
export const VELOCIDADES_DA_CAMPANHA = ["gradual", "rapida"] as const;

export type VelocidadeDaCampanha = (typeof VELOCIDADES_DA_CAMPANHA)[number];

export const STATUS_DO_DESTINATARIO = [
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
  /** Spec 21: saída própria de quem vira pessoal — nunca `opted_out` (D7). */
  "personal",
] as const;

export type StatusDoDestinatario = (typeof STATUS_DO_DESTINATARIO)[number];

/**
 * Estados dos quais o despacho não tira mais ninguém.
 *
 * `sent` está aqui e continua evoluindo para `delivered`/`read`/`replied`: a
 * campanha conclui quando não há mais o que DESPACHAR, não quando todo mundo
 * leu — esperar leitura deixaria campanha aberta para sempre por causa de quem
 * nunca abre o WhatsApp.
 */
export const TERMINAIS_DE_DESPACHO: ReadonlySet<StatusDoDestinatario> = new Set([
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
  "personal",
]);

/**
 * Os estados em que a campanha AINDA VAI falar com esta pessoa — a fila ativa.
 *
 * DERIVADO de `TERMINAIS_DE_DESPACHO`, e não uma segunda lista: o complemento é
 * exatamente "o que o despacho ainda pega". Escrever
 * `['pending','queued','sending']` à mão criaria duas verdades sobre a mesma
 * fronteira, e a que ninguém lembrasse de atualizar seria a que decide se uma
 * pessoa recebe duas abordagens.
 *
 * Quem o usa: o veto "já em campanha" (`contatosJaEmCampanha` e
 * `estaEmOutraCampanha`), para duas campanhas não mandarem o primeiro contato
 * para a mesma pessoa na mesma semana.
 */
export const NA_FILA_DE_DESPACHO: readonly StatusDoDestinatario[] = STATUS_DO_DESTINATARIO.filter(
  (s) => !TERMINAIS_DE_DESPACHO.has(s),
);

/**
 * Por que alguém do recorte não vai receber.
 *
 * Código, não frase: a frase é traduzida na borda (`TEXTO_DA_EXCLUSAO`), e
 * gravar frase no banco impede contar "quantos por motivo" sem `like`.
 */
export const MOTIVOS_DE_EXCLUSAO = [
  "sem_telefone",
  "telefone_invalido",
  "opt_out",
  "anonimizado",
  "recusou_marketing",
  "excluido_manualmente",
  "duplicado",
  "variavel_ausente",
  "texto_vazio",
  "ja_em_campanha",
  "suprimido",
  /**
   * O NEGÓCIO desta pessoa já foi fechado (ganho ou perdido) alguma vez
   * (migration 9040). Só a entrada CONTÍNUA o produz: no modo lista o recorte é
   * de contatos e não de negócios.
   *
   * Vira LINHA, e não silêncio, porque num modo de público sem lista é o único
   * jeito de o operador ver o veto comendo a base — antes dele o rastro era um
   * número no `detail` do `event_log`, que ninguém abre.
   */
  "negocio_ja_fechado",
  /** Spec 21: o contato virou pessoal e saiu da campanha com a saída própria. */
  "contato_pessoal",
] as const;

export type MotivoDeExclusao = (typeof MOTIVOS_DE_EXCLUSAO)[number];

/** O que o operador lê na tela. Espanhol entra pelo `traduzir()` da borda. */
export const TEXTO_DA_EXCLUSAO: Record<MotivoDeExclusao, string> = {
  sem_telefone: "Sem telefone no cadastro",
  telefone_invalido: "Telefone fora do formato de envio",
  opt_out: "Pediu para não receber mensagens",
  anonimizado: "Contato anonimizado (LGPD)",
  recusou_marketing: "Recusou receber contato comercial",
  excluido_manualmente: "Excluído à mão desta campanha",
  duplicado: "Mesmo telefone de outro contato da lista",
  variavel_ausente: "Falta um dado que a mensagem usa",
  // Separado de `variavel_ausente` porque a causa é outra e o conserto também:
  // ali falta dado do contato, aqui o TEXTO da variação resolveu para nada
  // (um `{Olá|}` com pipe sobrando rende vazio em metade das sementes). Dizer
  // "falta um dado" mandaria o operador procurar no cadastro, que está certo.
  texto_vazio: "A variação sorteada para esta pessoa ficou sem texto",
  ja_em_campanha: "Outra campanha já falou com esta pessoa nos últimos 30 dias, ou vai falar",
  suprimido: "Está na lista de exclusão de campanhas",
  negocio_ja_fechado: "Já comprou ou já foi perdido antes (não é primeiro contato)",
  contato_pessoal: "Contato marcado como pessoal",
};
