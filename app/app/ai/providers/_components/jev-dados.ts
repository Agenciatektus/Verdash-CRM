/** Tipos, regras de derivação e o hook de leitura do cartão do Jev. */
import { createContext, useCallback, useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoDaTarefa } from "@/lib/ai/decisao/config";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import type { OrigemDoJev } from "@/lib/ai/decisao/origem";
import { ROTEADOR_SOB_DEMANDA, TAREFA_DO_CLIMA, TAREFAS_DO_JEV, tarefaPodeDecidir } from "@/lib/ai/decisao/tarefas";
import type { ProvedorComChave } from "@/lib/ai/pontos/provedores";

/**
 * O aceite da empresa que está no padrão da plataforma (`config.no_padrao`):
 * `exigido` enquanto estiver no padrão, `dado` quando o checkbox está marcado.
 * Fora do padrão o contexto é `{ exigido: false }` e nada muda.
 */
export const AceiteDoPadrao = createContext<{ exigido: boolean; dado: boolean }>({ exigido: false, dado: false });

/**
 * O corpo do PATCH com o aceite, ou `null` quando ele é exigido e não foi dado.
 * Desligar nunca pede aceite; fora do padrão o corpo segue como veio.
 */
export function corpoComAceiteDoPadrao(
  corpo: Record<string, unknown>,
  aceite: { exigido: boolean; dado: boolean },
): Record<string, unknown> | null {
  if (!aceite.exigido || corpo.ligado === false) return corpo;
  return aceite.dado ? { ...corpo, aceite_lgpd: true } : null;
}

/** O corpo de `GET /api/v1/ai/jev` (`app/api/v1/ai/jev/route.ts`). */
export interface DadosDoJev {
  provedor: { rotulo: string; quandoUsar: string; ondePegarAChave: string; prefixoDaChave: string };
  chave: {
    existe: boolean;
    validada: boolean;
    credencial_id: string | null;
    rotulo: string | null;
    erro_de_validacao: string | null;
    /** De quem é a chave que o Jev usa. Ausente na imagem anterior. */
    fonte_da_chave?: "propria" | "plataforma" | "nenhuma";
  };
  /** A plataforma serve o Jev a esta empresa (só o booleano; a chave nunca chega à tela). */
  plataforma_tem_jev?: boolean;
  config: {
    /** Ligado pelo padrão da plataforma, sem aceite gravado: o aceite nunca vem na resposta. */
    no_padrao?: boolean;
    ligado: boolean;
    modo: "observacao" | "decide";
    modo_roteador?: "comparacao" | "sob_demanda";
    aceite: { em: string; por: string } | null;
  };
  tarefas: Array<{ id: string; rotulo: string; oQueOJevFaz: string }>;
  /**
   * O estado de cada tarefa, como a rota o resolve. Ausente na resposta da
   * imagem anterior (a página aberta durante um rollback): nela a única tarefa
   * é o clima, e o estado dele é o `modo`.
   */
  por_tarefa?: TarefaNoCartao[];
  tem_ia_de_sempre: boolean;
  /**
   * A IA de sempre do ROTEADOR, a mesma pergunta que o turno faz antes de deixar
   * o Jev rotear sozinho (`temIaDeSempre`). Ausente (imagem anterior) vale `false`:
   * sem saber, o cartão não oferece o modo que dispensaria a reserva.
   */
  roteador_tem_ia_de_sempre?: boolean;
  numeros: {
    dias: number;
    decisoes: number;
    /** `null` quando nenhuma medição tem preço conhecido. */
    custo_cents: number | null;
    /** Alguma medição veio de uma versão sem preço na tabela: a soma é parcial. */
    custo_incompleto: boolean;
    latencia_media_ms: number | null;
    reservas: number;
    /** Conversas em que a nota do Jev ficou abaixo do corte da passagem para humano. */
    irritados: number;
    observacao: {
      dias: number;
      comparadas: number;
      concordaram: number;
      /** Só a manipulação: em quantas das comparadas SÓ o Jev deu o alerta forte. */
      so_o_jev_alto?: number;
      /** Só o clima: a conta usou as N mensagens mais recentes, não o período inteiro. */
      teto_da_amostra?: number;
    };
  };
  /** `tarefa`: o rótulo da tarefa que falhou. Ausente na imagem anterior. */
  ultima_falha: { motivo: string | null; em: string; tarefa?: string | null } | null;
  /**
   * DE ONDE O JEV RESPONDE hoje (`@/lib/ai/decisao/origem`): a TypeSafe direto,
   * ou via OpenRouter. Ausente na resposta da imagem anterior (a página aberta
   * durante um rollback) e vale o caminho de sempre — TypeSafe direto, que é o
   * único que aquela imagem conhece.
   */
  origem?: OrigemDoJev;
  /**
   * O que a empresa já tem na OpenRouter, para o cartão oferecer REAPROVEITAR
   * em vez de exigir uma chave TypeSafe separada. `disponivel` é a credencial
   * OpenRouter validada da empresa; `rotulo` é o nome que ela deu à credencial.
   * Ausente na imagem anterior: sem ele, não se oferece nada.
   */
  openrouter?: { disponivel: boolean; rotulo: string | null };
  pode_editar: boolean;
}

export interface TarefaNoCartao {
  id: string;
  ponto: string | null;
  rotulo: string;
  oQueFaz: string;
  estado: EstadoDaTarefa;
  /** O estado em que ela fica se o Jev for ligado agora. Ausente, o clima volta pelo `modo`. */
  ao_ligar?: EstadoDaTarefa;
  /** Começou sozinha e ninguém escolheu nada ainda. */
  novo: boolean;
  /**
   * A concordância dela com a IA de sempre nos últimos dias. Ausente na
   * resposta da imagem anterior: lá só o clima a tinha, em `numeros.observacao`.
   */
  observacao?: Concordancia | null;
  /**
   * Só as tarefas em cascata, que o Jev responde onde a regra de hoje disse não:
   * em quantas MENSAGENS ele percebeu o pedido que ela não reconheceu, e as
   * conversas das mais recentes (o endereço já vem pronto da rota). Ausente na
   * imagem anterior.
   */
  percebidos?: { dias: number; mensagens: number; conversas: Array<{ href: string; em: string }> } | null;
  /**
   * A camada de segurança que ela acompanha está desligada para a empresa: o
   * turno não pergunta, e ela não roda em estado nenhum. Ausente na imagem anterior.
   */
  sem_camada?: boolean;
  /**
   * A do roteador numa empresa sem roteador de intenção ativo: o turno não
   * escolhe agente, e ela não tem o que comparar. Ausente na imagem anterior.
   */
  sem_roteador?: boolean;
  /**
   * As de pedido numa empresa em que o atendimento automático não roda em
   * número nenhum: ninguém no ar sem pausa, ou o atendimento com um sistema de
   * fora. O worker só as pergunta onde ele roda. Ausente na imagem anterior.
   */
  sem_atendente?: "externo" | "ninguem_no_ar" | null;
  /**
   * A do follow-up numa empresa sem follow-up publicado com o passo
   * "Classificar (IA)": ninguém lê a resposta do cliente, e ela não tem o que
   * comparar. Ausente na imagem anterior.
   */
  sem_fluxo?: boolean;
}

/** Algo fora do Jev a impede de rodar em qualquer estado — a camada, o roteador, quem atende ou o fluxo. */
export const parada = (t: TarefaNoCartao) =>
  t.sem_camada === true ||
  t.sem_roteador === true ||
  t.sem_fluxo === true ||
  (t.sem_atendente !== undefined && t.sem_atendente !== null);

/** A tarefa pode rodar agora — não está desligada nem parada. */
export const roda = (t: TarefaNoCartao) => t.estado !== "desligada" && !parada(t);

export type Concordancia = DadosDoJev["numeros"]["observacao"];

/** A concordância da tarefa — a do clima ainda vem em `numeros` na imagem anterior. */
export function concordanciaDa(tarefa: TarefaNoCartao, d: DadosDoJev): Concordancia | null {
  return tarefa.observacao ?? (tarefa.id === TAREFA_DO_CLIMA.id ? d.numeros.observacao : null);
}

/**
 * Como a tarefa volta ao ligar o Jev (`ao_ligar`, da rota). Na resposta da
 * imagem anterior só o clima existe, pelo `modo` — que sozinho mentia: o clima
 * desligado guarda o `modo` de antes, e o cartão prometia "volta decidindo".
 */
export function estadoAoLigar(tarefa: TarefaNoCartao, d: DadosDoJev): EstadoDaTarefa {
  if (tarefa.ao_ligar) return tarefa.ao_ligar;
  if (tarefa.id === TAREFA_DO_CLIMA.id) return d.config.modo === "decide" ? "decidindo" : "observando";
  return "observando";
}

export function tarefasDoCartao(d: DadosDoJev): TarefaNoCartao[] {
  if (d.por_tarefa) return d.por_tarefa;
  return [
    {
      id: TAREFA_DO_CLIMA.id,
      ponto: TAREFA_DO_CLIMA.ponto,
      rotulo: TAREFA_DO_CLIMA.rotulo,
      oQueFaz: TAREFA_DO_CLIMA.oQueFaz,
      estado: d.config.modo === "decide" ? "decidindo" : "observando",
      novo: false,
    },
  ];
}

/**
 * O corpo do PATCH que põe a tarefa num estado. O clima muda pelo `modo`, o
 * nome da onda 1: com a página aberta durante um rollback, a imagem anterior
 * entende o pedido — e `{ tarefa: "clima" }` chegaria ao mesmo lugar nesta.
 * Pausar não tem nome no `modo`, e vai sempre por `tarefa`.
 */
export function corpoDaMudanca(tarefa: TarefaNoCartao, estado: EstadoDaTarefa) {
  if (tarefa.id === TAREFA_DO_CLIMA.id && estado !== "desligada") {
    return { modo: estado === "decidindo" ? "decide" : "observacao" };
  }
  return { tarefa: tarefa.id, estado };
}

export type Estado =
  | "sem_chave"
  | "chave_nao_validada"
  | "pronto"
  | "observando"
  | "decidindo"
  | "sozinho"
  | "em_pausa"
  | "parado";

export function estadoDoJev(d: DadosDoJev): Estado {
  if (d.config.ligado) {
    // Ligado sem chave que passou no teste, o Jev não mede nada (o worker só
    // usa chave validada). Um selo "Decidindo" aqui afirmaria o contrário.
    if (!d.chave.validada) return "parado";
    // Pelo estado de cada TAREFA, e não pelo `modo`: o clima desligado sozinho
    // guarda o `modo` de antes, e um "Observando" aqui afirmaria que ele mede.
    const tarefas = tarefasDoCartao(d);
    const clima = tarefas.find((t) => t.id === TAREFA_DO_CLIMA.id);
    // Sem a IA de sempre não há com quem comparar nem quem cubra: o worker
    // deixa o Jev decidir o clima qualquer que seja o estado — menos desligado.
    if (!d.tem_ia_de_sempre && clima && clima.estado !== "desligada") return "sozinho";
    // A tarefa parada pela camada não mede nada: não faz o cartão observar nem decidir.
    const rodando = tarefas.filter(roda);
    if (rodando.some(decide)) return "decidindo";
    if (rodando.length > 0) return "observando";
    return "em_pausa";
  }
  if (!d.chave.existe) return "sem_chave";
  if (!d.chave.validada) return "chave_nao_validada";
  return "pronto";
}

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

/** A origem que a resposta diz — ausente (imagem anterior) é o caminho de sempre. */
export const origemDoCartao = (d: DadosDoJev): OrigemDoJev => d.origem ?? "typesafe";

/**
 * O provedor da credencial que ESTA origem consome (`lib/ai/decisao/origem`): a
 * chave do Jev na TypeSafe, ou a credencial OpenRouter da empresa. É o que a
 * frase de recusa e o diálogo de colar a chave precisam saber para apontar a
 * conta certa — via OpenRouter, "cadastre na TypeSafe" pediria a coisa errada.
 */
export const provedorDaCredencialDoCartao = (d: DadosDoJev): ProvedorComChave =>
  origemDoCartao(d) === "openrouter" ? "openrouter" : PROVEDOR_DO_JEV;

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

export type Resposta = { data?: DadosDoJev; error?: { message?: string } };

/**
 * Uma leitura da rota. A recusa dela já vem escrita para leigo; o que o
 * navegador diz numa falha de rede ("Failed to fetch") é inglês e não diz nada,
 * e um corpo sem mensagem (proxy) não tem o que mostrar além do fato.
 */
export async function buscarDadosDoJev(
  t: (texto: string) => string,
): Promise<{ dados: DadosDoJev } | { erro: string }> {
  try {
    const res = await fetch("/api/v1/ai/jev");
    const json = (await res.json().catch(() => null)) as Resposta | null;
    if (res.ok && json?.data) return { dados: json.data };
    return { erro: json?.error?.message ? t(json.error.message) : t("Não consegui carregar o cartão agora.") };
  } catch {
    return { erro: t("Não consegui falar com o servidor. Confira a internet e tente de novo.") };
  }
}

/** Carrega o cartão. Mora no painel porque o cartão do ponto também o lê. */
export function useDadosDoJev() {
  const t = useT();
  const [dados, setDados] = useState<DadosDoJev | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const aplicar = useCallback((r: { dados: DadosDoJev } | { erro: string }) => {
    if ("erro" in r) {
      setErro(r.erro);
      return;
    }
    setErro(null);
    setDados(r.dados);
  }, []);

  const recarregar = useCallback(async () => aplicar(await buscarDadosDoJev(t)), [aplicar, t]);

  useEffect(() => {
    // A primeira leitura resolve DEPOIS do efeito (nada de setState no corpo
    // dele), e a resposta de um cartão já desmontado é descartada.
    let vivo = true;
    void buscarDadosDoJev(t).then((r) => {
      if (vivo) aplicar(r);
    });
    return () => {
      vivo = false;
    };
  }, [aplicar, t]);

  return { dados, erro, recarregar };
}
