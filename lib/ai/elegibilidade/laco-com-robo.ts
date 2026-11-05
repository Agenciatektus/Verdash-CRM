/**
 * Freio de laço com robô: a IA e uma URA/autoresposta do outro lado trocando
 * mensagens sem parar (Lior, 28/10: 149 da IA contra 298 de entrada em 24h).
 * Função PURA; a leitura e o efeito moram em `consulta-laco.ts`.
 */

/** Prefixo do `last_handoff_reason` gravado ao silenciar; a devolução automática o usa para NÃO devolver. */
export const MOTIVO_LACO_PREFIXO = "Automático pausado: laço com robô";
export const JANELA_LACO_MS = 60 * 60 * 1000;
/** Bolhas da IA na janela (o agente divide a resposta em várias bolhas curtas). */
export const LIMITE_VOLUME_IA = 16;
/** Mensagens do cliente na mesma janela: exige tráfego dos dois lados. */
export const LIMITE_VOLUME_CLIENTE = 12;
export const ENTRADAS_ANALISADAS = 12;
export const LIMITE_REPETICAO = 3;
export const TAMANHO_MINIMO_REPETIDO = 20;
/** Resposta de máquina: chega até este tempo depois da última saída. Gente digita e leva mais (Regina, 03/11: 12 de 12 ficaram acima). */
export const RESPOSTA_DE_MAQUINA_MS = 15_000;
/** Teto de volume que vale sem olhar o tempo de resposta (robô lento, envio na fila): humano não chega aqui em 1 h. */
export const TETO_VOLUME_IA = 40;
export const TETO_VOLUME_CLIENTE = 20;
/** Quantas entradas de máquina a janela precisa ter para o volume contar como laço. */
export const LIMITE_ENTRADAS_DE_MAQUINA = 6;
/**
 * Frases (já normalizadas) que só uma URA/assistente virtual escreve; cliente de verdade não.
 * Salão Fabiana, 04/11: a IA respondeu 7 vezes à URA da Light sem passar volume nem repetição.
 * Frase que humano também diz ("você ainda está por aí?", "vou encerrar o atendimento") fica de fora.
 */
export const SINAIS_DE_URA = [
  "assistente virtual",
  "atendente virtual",
  "digite uma das opcoes",
  "escolha uma das opcoes",
  "digite o numero da opcao",
  "nao entendi o que voce digitou",
  "nao consegui identificar sua resposta",
] as const;
/** Entradas com sinal de URA na janela para silenciar (uma sozinha pode ser citação). */
export const LIMITE_SINAIS_DE_URA = 2;

export interface MensagemDaConversa {
  direcao: "inbound" | "outbound";
  texto: string | null;
  enviadoEm: Date;
  enviadaPelaIa: boolean;
}

export interface DecisaoDeLaco {
  laco: boolean;
  motivo: "volume" | "repeticao" | "ura" | null;
}

export function normalizarTexto(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[0-9]/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function entradasDeMaquina(naJanela: MensagemDaConversa[]): number {
  const ordem = [...naJanela].sort((a, b) => a.enviadoEm.getTime() - b.enviadoEm.getTime());
  let ultimaSaida: number | null = null;
  let n = 0;
  for (const m of ordem) {
    if (m.direcao === "outbound") ultimaSaida = m.enviadoEm.getTime();
    else if (ultimaSaida !== null && m.enviadoEm.getTime() - ultimaSaida <= RESPOSTA_DE_MAQUINA_MS) {
      n++;
      ultimaSaida = null; // uma entrada de máquina por saída: humano em rajada não soma
    }
  }
  return n;
}

export function detectarLacoComRobo(
  mensagens: MensagemDaConversa[],
  agora: Date = new Date(),
): DecisaoDeLaco {
  const desde = agora.getTime() - JANELA_LACO_MS;
  const naJanela = mensagens.filter((m) => m.enviadoEm.getTime() >= desde);

  // URA se denuncia no texto, antes de qualquer volume: cada resposta da IA a ela é lixo e custo.
  const sinaisDeUra = naJanela.filter((m) => {
    if (m.direcao !== "inbound") return false;
    const n = normalizarTexto(m.texto ?? "");
    return SINAIS_DE_URA.some((f) => n.includes(f));
  }).length;
  if (sinaisDeUra >= LIMITE_SINAIS_DE_URA) return { laco: true, motivo: "ura" };

  const ia = naJanela.filter((m) => m.direcao === "outbound" && m.enviadaPelaIa).length;
  const cliente = naJanela.filter((m) => m.direcao === "inbound").length;
  // Volume sozinho pega cliente de verdade conversando (a IA fala em 2 bolhas por turno).
  // Só é laço se as entradas voltam em segundos, como URA/autoresposta.
  if (ia >= TETO_VOLUME_IA && cliente >= TETO_VOLUME_CLIENTE) return { laco: true, motivo: "volume" };
  if (ia >= LIMITE_VOLUME_IA && cliente >= LIMITE_VOLUME_CLIENTE && entradasDeMaquina(naJanela) >= LIMITE_ENTRADAS_DE_MAQUINA) {
    return { laco: true, motivo: "volume" };
  }

  // Humano repetindo "me atende" sem a IA responder não é laço.
  if (ia < LIMITE_REPETICAO) return { laco: false, motivo: null };

  const contagem = new Map<string, number>();
  const entradas = naJanela
    .filter((m) => m.direcao === "inbound")
    .sort((a, b) => b.enviadoEm.getTime() - a.enviadoEm.getTime())
    .slice(0, ENTRADAS_ANALISADAS);
  for (const m of entradas) {
    const n = normalizarTexto(m.texto ?? "");
    if (n.length < TAMANHO_MINIMO_REPETIDO) continue;
    const c = (contagem.get(n) ?? 0) + 1;
    if (c >= LIMITE_REPETICAO) return { laco: true, motivo: "repeticao" };
    contagem.set(n, c);
  }
  return { laco: false, motivo: null };
}
