import type { EtapaDoFunil, MensagemDaConversa } from "./decidir";

/**
 * Regras da loja que o código decide SEM perguntar ao modelo (ele errou nelas na amostra da Fiorotto):
 * resposta automática, disparo manual sem resposta, troca/devolução e silêncio de N dias.
 * Configuradas em `settings.organizador.regras`; sem a chave, a regra fica desligada. A única que vale
 * para todas as orgs é ignorar resposta automática: ela nunca é "o cliente respondeu".
 */
export interface RegrasDaLoja {
  /** Nome da etapa (do mesmo funil) onde ficam os leads que só receberam disparo. */
  etapa_disparo?: string;
  /** Nome do FUNIL de pós-venda: conversa de troca/devolução/garantia leva o mesmo card para lá. */
  funil_posvenda?: string;
  /** Dias de silêncio (depois da última mensagem da loja) até dar o lead como perdido. */
  dias_para_perda?: number;
  /** Motivo de perda do vocabulário do funil. */
  motivo_perda?: string;
}

export function lerRegras(bruto: unknown): RegrasDaLoja {
  const r = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
  const dias = Number(r.dias_para_perda);
  return {
    etapa_disparo: txt(r.etapa_disparo),
    funil_posvenda: txt(r.funil_posvenda),
    dias_para_perda: Number.isFinite(dias) && dias >= 1 ? Math.min(Math.floor(dias), 90) : undefined,
    motivo_perda: txt(r.motivo_perda),
  };
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Frases de robô de WhatsApp Business/chatbot. Lista curta e conservadora: errar para "é humano" só
// devolve a decisão ao modelo; errar para "é robô" esconderia um cliente de verdade.
const AUTOMATICA = [
  "assistente virtual",
  "atendimento automatico",
  "mensagem automatica",
  "resposta automatica",
  "somos um (bot|robo)",
  "sou um (bot|robo)",
  "digite (o numero|1|2|3)",
  "escolha uma das opcoes",
  "como posso (te |lhe )?ajudar hoje",
  "passei sua (oferta|mensagem) para a nossa equipe",
  "encaminhei (sua|a) (mensagem|solicitacao) para",
  "fora do (nosso )?horario de atendimento",
  "no momento nao (estamos|podemos) atend",
  "em breve (um|uma) (de nossos|atendente|consultor|especialista)",
  "em breve nossa equipe",
  "obrigado por entrar em contato",
  "agradecemos (o|seu) contato",
];
const AUTOMATICA_RE = new RegExp(AUTOMATICA.join("|"));

export function ehAutomatica(texto: string | null): boolean {
  return AUTOMATICA_RE.test(norm(texto ?? ""));
}

/** Tira da conversa o que é resposta automática do lado do cliente: ela não é "o cliente respondeu". */
export function semAutomaticas(historico: MensagemDaConversa[]): MensagemDaConversa[] {
  return historico.filter((m) => !(m.direction === "inbound" && ehAutomatica(m.body)));
}

// Inbound sem texto é áudio/imagem/figurinha do cliente: também é resposta.
export const clienteRespondeu = (h: MensagemDaConversa[]) => h.some((m) => m.direction === "inbound");

// Troca/devolução só conta com sinal de compra vindo da LOJA ("seu pedido", nota fiscal, rastreio, Pix
// recebido): "dá pra trocar o tamanho?" ou "qual a garantia?" antes de comprar é venda, e "chegou a coleção
// nova" ou "fazemos entrega" em disparo não prova compra. A fala do cliente sozinha nunca sustenta movimento.
const POS_TROCA = /\b(troca|trocar|trocado|devolv\w*|devoluc\w*|garantia|defeito)\b/;
const COMPRA_DA_LOJA = /(seu pedido|pedido #|nota fiscal|codigo de rastreio|rastreio|pix recebido|pagamento (confirmado|recebido|aprovado)|compra confirmada|ja enviamos|despachamos|postamos)/;

/** A loja confirmou venda/envio nesta conversa. */
export function lojaConfirmouCompra(historico: MensagemDaConversa[]): boolean {
  return historico.some((m) => m.direction === "outbound" && COMPRA_DA_LOJA.test(norm(m.body ?? "")));
}

// Venda em andamento: o cliente fechou item, mandou endereço COM número, falou de pagamento, ou a loja afirmou "fechou".
// Num negócio assim o silêncio é pausa da venda, não desistência: o prazo de perda não se aplica e o modelo decide.
// Só conta afirmação: pergunta ("qual o endereço?", "frete pro cep 01001-000?") é pré-venda e não bloqueia.
// Pix, cartão e motoboy aparecem em toda resposta de preço da loja, então só valem na fala do CLIENTE.
const PERGUNTA = /\?|^\s*(qual|quais|quanto|como|onde|tem|voces)\b/;
const FECHAMENTO_DO_CLIENTE =
  /(vou querer|vou levar|quero (esse|essa|dois|duas|sim|o \w+|\d+(?![\d%]))|comprovante|paguei|pix feito|transferi|mando o pix|vou fazer o pix|pode separar|vou (buscar|retirar)|retiro (ai|na loja)|\b(rua|r\.|av\.?|avenida|travessa|alameda)\s+\S+.*\d|\bcep\b\D{0,5}\d{5}-?\d{3}|^\s*(fechado|fechou)\b)/;
// A loja só confirma fechamento quando a mensagem COMEÇA assim e não pergunta ("domingo fechado", "combinado?" não contam).
const FECHAMENTO_DA_LOJA = /^\s*(fechou|fechado|combinado)\b[^?]*$/;

export function temSinalDeFechamento(historico: MensagemDaConversa[]): boolean {
  return historico.some((m) => {
    const t = norm(m.body ?? "");
    return m.direction === "inbound" ? !PERGUNTA.test(t) && FECHAMENTO_DO_CLIENTE.test(t) : FECHAMENTO_DA_LOJA.test(t);
  });
}

/** O cliente fala de troca/devolução/garantia de uma venda que a loja confirmou: o negócio é pós-venda. */
export function pedeTroca(historico: MensagemDaConversa[]): boolean {
  return clienteRespondeu(historico) && ehTrocaOuDevolucao(historico);
}

export function ehTrocaOuDevolucao(historico: MensagemDaConversa[]): boolean {
  const fala = historico.slice(-12).filter((m) => m.direction === "inbound").map((m) => norm(m.body ?? ""));
  return fala.some((t) => POS_TROCA.test(t)) && lojaConfirmouCompra(historico);
}

export function etapaPorNome(etapas: EtapaDoFunil[], nome: string | undefined): EtapaDoFunil | undefined {
  if (!nome) return undefined;
  const alvo = norm(nome);
  return etapas.find((e) => !e.is_archived && norm(e.name) === alvo);
}

export type Atalho = { mover: true; etapa: EtapaDoFunil; justificativa: string; lostReason?: string } | { mover: false };

/**
 * Atalhos que dispensam o modelo. Só AVANÇAM (mesma trava do `decide`) e nunca tocam ganho.
 * Hoje: disparo sem resposta do cliente. A troca/devolução troca de FUNIL e mora em `varredura.ts`.
 */
export function atalhoDaLoja(
  regras: RegrasDaLoja,
  etapas: EtapaDoFunil[],
  atualId: string,
  historico: MensagemDaConversa[],
): Atalho {
  const atual = etapas.find((e) => e.id === atualId);
  if (!atual) return { mover: false };
  const disparo = etapaPorNome(etapas, regras.etapa_disparo);
  if (disparo && !disparo.is_won && !disparo.is_lost && disparo.position > atual.position && !clienteRespondeu(historico)) {
    return { mover: true, etapa: disparo, justificativa: "Só mensagens da loja (disparo manual), sem resposta do cliente: tratado como campanha." };
  }
  return { mover: false };
}

export type Silencio = "perder" | "nao_vencido" | "compra_confirmada" | "sinal_de_fechamento";

/**
 * Silêncio: o cliente respondeu alguma vez, a última mensagem útil é da loja e passou o prazo.
 * O motivo do bloqueio sai com rótulo, para o dry_run mostrar quantos leads o filtro segurou.
 */
export function avaliaSilencio(regras: RegrasDaLoja, historico: MensagemDaConversa[], agora: Date): Silencio {
  if (!regras.dias_para_perda) return "nao_vencido";
  const h = semAutomaticas(historico);
  if (!clienteRespondeu(h)) return "nao_vencido"; // nunca respondeu = campanha, não perda
  const ultima = h[h.length - 1];
  if (!ultima || ultima.direction !== "outbound") return "nao_vencido";
  if (agora.getTime() - new Date(ultima.sent_at).getTime() < regras.dias_para_perda * 86_400_000) return "nao_vencido";
  // Venda confirmada pela loja e ainda sem "ganho" marcado por humano não é lead perdido: o ganho é decisão humana.
  if (lojaConfirmouCompra(h)) return "compra_confirmada";
  if (temSinalDeFechamento(h)) return "sinal_de_fechamento";
  return "perder";
}

export const perdidoPorSilencio = (regras: RegrasDaLoja, historico: MensagemDaConversa[], agora: Date) =>
  avaliaSilencio(regras, historico, agora) === "perder";
