import type { VisaoDaAgenda } from "@/components/agenda/tipos";

/**
 * A visão com que a Agenda abre, pela largura da janela (DS v2): celular
 * (< 760px) abre no DIA, tablet (760 a 1023px, o iPad 820 incluso) em 3 DIAS,
 * desktop na SEMANA. Em 7 colunas o evento do tablet media 26px e o sábado era
 * cortado; em 3 dias cada coluna passa de 180px.
 *
 * Recebe a pergunta `matches` em vez de ler `window`: o chamador decide quando
 * perguntar (num efeito, porque o servidor não tem janela).
 */
export function visaoPadraoDaLargura(
  casa: (consulta: string) => boolean,
): VisaoDaAgenda {
  if (casa("(max-width: 759px)")) return "dia";
  if (casa("(max-width: 1023px)")) return "tres";
  return "semana";
}
