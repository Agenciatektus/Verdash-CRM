/**
 * GATILHO POR FRASE: a equipe digita uma frase combinada ("pedido confirmado") e o
 * card vai para a etapa que a cadastrou. Cada etapa guarda até 5 frases
 * (`crm_stages.gatilho_frases`, migration 9092). Este arquivo só decide; quem lê o
 * evento e move o card é `gatilho-por-frase.handler.ts`.
 *
 * Regras herdadas da Verdash, que já passou por isso em produção:
 * - só vale mensagem ENVIADA pela loja (evento `message.sent`); fala do cliente
 *   nunca é gatilho, e essa trava é de quem emite o evento, não do texto;
 * - casa por trecho, sem acento nem caixa;
 * - mais de uma etapa casando: a de maior posição vence;
 * - só avança: frase de etapa antiga repetida no meio da conversa não recua o card.
 */

export const MAX_FRASES_POR_ETAPA = 5;
export const MIN_CARACTERES_DA_FRASE = 3;
export const MAX_CARACTERES_DA_FRASE = 120;

/** Minúscula, sem acento, espaços colapsados: a forma em que texto e frase são comparados. */
export function normaliza(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** O que a tela manda ao salvar: uma frase por linha vira lista, sem vazias nem repetidas. */
export function dividirFrases(bruto: string): string[] {
  const vistas = new Set<string>();
  const frases: string[] = [];
  for (const linha of bruto.split("\n")) {
    const frase = linha.trim();
    const chave = normaliza(frase);
    if (frase === "" || vistas.has(chave)) continue;
    vistas.add(chave);
    frases.push(frase);
  }
  return frases;
}

/** Só letras e números, palavras separadas por um espaço: a forma em que o casamento é por PALAVRA inteira. */
function palavras(texto: string): string {
  return normaliza(texto).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface EtapaComFrases {
  id: string;
  position: number;
  is_lost: boolean;
  is_archived: boolean;
  gatilho_frases: string[] | null;
}

/**
 * A etapa que a mensagem aciona, ou `null`. Perda fica de fora: ela exige um motivo
 * que a frase não carrega, e o funil recusaria o movimento.
 */
export function etapaQueCasa(
  texto: string,
  etapas: readonly EtapaComFrases[],
): { etapa: EtapaComFrases; frase: string } | null {
  // " sim " não está em " assim ": frase curta não casa no meio de outra palavra.
  const alvo = ` ${palavras(texto)} `;
  if (alvo.trim() === "") return null;
  let melhor: { etapa: EtapaComFrases; frase: string } | null = null;
  for (const etapa of etapas) {
    if (etapa.is_archived || etapa.is_lost) continue;
    for (const frase of etapa.gatilho_frases ?? []) {
      if (typeof frase !== "string") continue;
      const chave = palavras(frase);
      if (chave.length < MIN_CARACTERES_DA_FRASE || !alvo.includes(` ${chave} `)) continue;
      if (!melhor || etapa.position > melhor.etapa.position) melhor = { etapa, frase };
      break;
    }
  }
  return melhor;
}
