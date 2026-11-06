/** Tipos e derivações básicas do cartão do Jev. */


import { decide } from "./jev-regras";

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

// Quem importava daqui continua importando: regras e leitura moraram neste arquivo.
export * from "./jev-regras";
export * from "./jev-leitura";
