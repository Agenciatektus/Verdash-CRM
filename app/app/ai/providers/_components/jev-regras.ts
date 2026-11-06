/** Regras do selo e das frases do cartão do Jev (derivadas, nunca guardadas). */
import { ROTEADOR_SOB_DEMANDA, TAREFA_DO_CLIMA, TAREFAS_DO_JEV, tarefaPodeDecidir } from "@/lib/ai/decisao/tarefas";

import { DadosDoJev, TarefaNoCartao, roda, tarefasDoCartao } from "./jev-dados";

/**
 * "Decidindo" com uma tarefa ainda só observando. O selo e a frase do cartão
 * inteiro não podem falar por todas: o clima observando com a manipulação
 * decidindo é o caminho natural depois do selo "Novo" e de um clique.
 */
export function decideEmParte(d: DadosDoJev): boolean {
  return tarefasDoCartao(d).some((t) => roda(t) && !decide(t));
}

/**
 * A tarefa no registro: é dela a frase do "Decide" (`aoDecidir`,
 * `aoDecidirNoPonto`) — o que decidir quer dizer muda de uma tarefa para outra.
 */
export const doRegistro = (tarefaId: string) => TAREFAS_DO_JEV.find((x) => x.id === tarefaId);

/**
 * A tarefa em cascata não decide nada no lugar da regra de hoje: o estado
 * `decidindo` dela abre um aviso na Central, e a tela o chama "Avisar a
 * equipe" — nunca "Deixar o Jev decidir", que prometeria passar a conversa ou
 * bloquear o contato.
 */
export const avisaAEquipe = (tarefaId: string) => doRegistro(tarefaId)?.familia === "cascata";

/**
 * A tarefa oferece "Deixar o Jev decidir" (ou "Avisar a equipe")? A que só
 * observa nesta versão, não — e a rota recusaria o pedido. Uma tarefa que esta
 * página não conhece (de uma versão mais nova) segue com o botão, como antes.
 */
export const podeDecidir = (tarefaId: string) => {
  const registro = doRegistro(tarefaId);
  return registro === undefined || tarefaPodeDecidir(registro);
};

/**
 * A tarefa DECIDE algo no lugar do mecanismo de hoje. A em cascata, avisando a
 * equipe, não: o cliente não sente nada, e o estado do cartão inteiro (selo,
 * frase, texto de antes de ligar) a conta como quem não decide. Só a linha
 * dela diz "Avisa a equipe".
 */
export const decide = (t: TarefaNoCartao) => t.estado === "decidindo" && !avisaAEquipe(t.id);

/**
 * As tarefas que rodam, pela família: as que o Jev compara com a IA de sempre,
 * e as em cascata, que só contam as mensagens com um pedido que a regra de hoje
 * não reconheceu (e, em "Avisar a equipe", abrem aviso). A frase do cartão não
 * pode falar de comparar nem da "sua IA de sempre" quando só estas rodam.
 */
export function oQueRoda(d: DadosDoJev): { comparam: number; daParaDeixarDecidir: boolean; cascata: number; avisando: boolean } {
  const rodando = tarefasDoCartao(d).filter(roda);
  const cascata = rodando.filter((t) => avisaAEquipe(t.id));
  const comparam = rodando.filter((t) => !avisaAEquipe(t.id));
  return {
    comparam: comparam.length,
    // Com todas as que comparam só observando sem como decidir (a do
    // follow-up), "antes de deixar o Jev decidir" prometeria um botão que não há.
    daParaDeixarDecidir: comparam.some((t) => podeDecidir(t.id)),
    cascata: cascata.length,
    avisando: cascata.some((t) => t.estado === "decidindo"),
  };
}

/** A frase do cartão observando — verdadeira para o que de fato roda. */
export function fraseObservando(d: DadosDoJev, t: (texto: string) => string): string {
  const r = oQueRoda(d);
  if (r.comparam === 0) {
    return r.avisando
      ? t("Observando — o Jev conta as mensagens em que o cliente faz um pedido que a regra de hoje não reconheceu, e avisa a equipe na Central. Ele não decide nada no atendimento.")
      : t("Observando — o Jev só conta as mensagens em que o cliente faz um pedido que a regra de hoje não reconheceu. Nada muda no atendimento.");
  }
  if (!r.daParaDeixarDecidir) {
    if (r.cascata === 0) return t("Observando — a sua IA de sempre decide, e o Jev só é comparado com ela.");
    return r.avisando
      ? t("Observando — onde o Jev compara, a sua IA de sempre decide, e ele só é comparado com ela. Nos pedidos do cliente, ele conta as mensagens em que a regra de hoje não reconheceu o pedido, e avisa a equipe.")
      : t("Observando — onde o Jev compara, a sua IA de sempre decide, e ele só é comparado com ela. Nos pedidos do cliente, ele só conta as mensagens em que a regra de hoje não reconheceu o pedido.");
  }
  if (r.cascata === 0) return t("Observando — a sua IA de sempre ainda decide. Compare os dois antes de deixar o Jev decidir.");
  return r.avisando
    ? t("Observando — onde o Jev compara, a sua IA de sempre ainda decide: compare os dois antes de deixar o Jev decidir. Nos pedidos do cliente, ele conta as mensagens em que a regra de hoje não reconheceu o pedido, e avisa a equipe.")
    : t("Observando — onde o Jev compara, a sua IA de sempre ainda decide: compare os dois antes de deixar o Jev decidir. Nos pedidos do cliente, ele só conta as mensagens em que a regra de hoje não reconheceu o pedido.");
}

/** A frase do cartão decidindo: "em parte" nomeia também quem só avisa a equipe. */
export function fraseDecidindo(d: DadosDoJev, t: (texto: string) => string): string {
  if (!decideEmParte(d)) return t("Decidindo — cada tarefa abaixo diz o que o Jev decide nela.");
  return oQueRoda(d).avisando
    ? t("Decidindo em parte — cada tarefa abaixo diz se o Jev decide, só observa ou avisa a equipe nela.")
    : t("Decidindo em parte — cada tarefa abaixo diz se o Jev decide ou só observa nela.");
}

/**
 * Como o Jev está no ponto `pontoId`, para a linha do cartão do ponto — pelo
 * estado da tarefa dele. Decidindo, a linha é a da tarefa (`aoDecidirNoPonto`):
 * "o modelo abaixo é a reserva" só é verdade no clima.
 */
/**
 * O modo do roteador que VALE: sob demanda só onde a empresa tem a IA de sempre
 * (decisão B do doc 89). Sem ela o turno compara, e o cartão diz o mesmo.
 */
export function roteadorSobDemanda(d: DadosDoJev): boolean {
  return d.config.modo_roteador === "sob_demanda" && d.roteador_tem_ia_de_sempre === true;
}


export function jevNoPonto(
  d: DadosDoJev | null,
  pontoId: string,
): "observacao" | "sozinho" | { decide: string } | null {
  if (!d?.config.ligado || !d.chave.validada) return null;
  const tarefa = tarefasDoCartao(d).find((t) => t.ponto === pontoId);
  if (!tarefa || !roda(tarefa)) return null;
  // A IA de sempre é a do clima (`tem_ia_de_sempre`), e só o clima decide sem ela (DEC-012 #5).
  if (!d.tem_ia_de_sempre && tarefa.id === TAREFA_DO_CLIMA.id) return "sozinho";
  if (tarefa.estado !== "decidindo") return "observacao";
  const frase = tarefa.id === "roteador" && roteadorSobDemanda(d)
    ? ROTEADOR_SOB_DEMANDA : doRegistro(tarefa.id)?.aoDecidirNoPonto;
  return frase === undefined ? null : { decide: frase };
}
