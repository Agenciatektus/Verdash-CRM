/**
 * O RECORTE da tela de Tarefas: filtros (na URL e lembrados por pessoa), as
 * contagens dos atalhos, a ordem dentro do grupo e o agrupamento por
 * responsável. Lógica pura, no padrão de `lib/kanban/filters.ts` +
 * `useRecorteDoFunil`: o hook só liga isto à URL.
 *
 * Tudo roda sobre a lista que a rota já devolveu (as abertas e as encerradas
 * dos últimos dias, ou a situação escolhida): nenhuma consulta nova por filtro.
 * Os textos são CÓDIGOS; a tela os passa por `t()`.
 */
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  estaAtrasada,
  estaEncerrada,
  faixaDePrazo,
  PRIORIDADES_DA_TAREFA,
  SITUACOES_DA_TAREFA,
  type PrioridadeDaTarefa,
  type SituacaoDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";

/** "aberto" não é situação do banco: é o recorte que a tela abre por padrão. */
export type SituacaoDoFiltro = "aberto" | SituacaoDaTarefa;
export const SITUACOES_DO_FILTRO: readonly SituacaoDoFiltro[] = ["aberto", ...SITUACOES_DA_TAREFA];

export const PERIODOS_DO_PRAZO = ["vencidas", "hoje", "amanha", "proximos_7", "sem_prazo"] as const;
export type PeriodoDoPrazo = (typeof PERIODOS_DO_PRAZO)[number];

/** De que a tarefa é: de um negócio, só de um contato, ou de ninguém (avulsa). */
export const VINCULOS = ["negocio", "contato", "avulsa"] as const;
export type Vinculo = (typeof VINCULOS)[number];

export const ORDENS_DAS_TAREFAS = ["prazo", "prioridade", "criacao"] as const;
export type OrdemDasTarefas = (typeof ORDENS_DAS_TAREFAS)[number];

export const AGRUPAMENTOS = ["prazo", "responsavel"] as const;
export type Agrupamento = (typeof AGRUPAMENTOS)[number];

/** Responsável no painel: eu, sem ninguém, ou o id de um membro. */
export type FiltroDeResponsavel = "eu" | "sem" | string;

export interface FiltrosDeTarefas {
  busca?: string;
  // Atalhos de um toque (a linha da barra).
  minhas?: true;
  atrasadas?: true;
  hoje?: true;
  semResponsavel?: true;
  // Painel "Filtros".
  responsavel?: FiltroDeResponsavel;
  prioridades?: PrioridadeDaTarefa[];
  periodo?: PeriodoDoPrazo;
  vinculo?: Vinculo;
  funil?: string;
  etapa?: string;
  situacao?: SituacaoDoFiltro;
  // Como mostrar.
  ordem?: OrdemDasTarefas;
  agrupar?: Agrupamento;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUm = <T extends string>(lista: readonly T[], v: string | null): v is T => !!v && (lista as readonly string[]).includes(v);

/**
 * URL → filtros. Valor que não é do vocabulário é IGNORADO (link velho ou
 * digitado à mão não quebra a tela, só não filtra).
 */
export function filtrosDaUrl(params: URLSearchParams): FiltrosDeTarefas {
  const f: FiltrosDeTarefas = {};
  const q = params.get("q")?.trim();
  if (q) f.busca = q.slice(0, 120);
  // `?assigned_to=me` é o endereço que o lembrete e o push de tarefa abrem (upstream 1.90).
  if (params.get("minhas") === "1" || params.get("assigned_to") === "me") f.minhas = true;
  if (params.get("atrasadas") === "1") f.atrasadas = true;
  if (params.get("hoje") === "1") f.hoje = true;
  if (params.get("sem_resp") === "1") f.semResponsavel = true;
  const resp = params.get("resp");
  if (resp === "eu" || resp === "sem" || (resp && UUID.test(resp))) f.responsavel = resp;
  const prio = (params.get("prio") ?? "").split(",").filter((p): p is PrioridadeDaTarefa => ehUm(PRIORIDADES_DA_TAREFA, p));
  if (prio.length) f.prioridades = [...new Set(prio)];
  const periodo = params.get("periodo");
  if (ehUm(PERIODOS_DO_PRAZO, periodo)) f.periodo = periodo;
  const vinculo = params.get("vinculo");
  if (ehUm(VINCULOS, vinculo)) f.vinculo = vinculo;
  const funil = params.get("funil");
  if (funil && UUID.test(funil)) {
    f.funil = funil;
    const etapa = params.get("etapa");
    if (etapa && UUID.test(etapa)) f.etapa = etapa;
  }
  const situacao = params.get("situacao");
  if (ehUm(SITUACOES_DO_FILTRO, situacao) && situacao !== "aberto") f.situacao = situacao;
  const ordem = params.get("ordem");
  if (ehUm(ORDENS_DAS_TAREFAS, ordem) && ordem !== "prazo") f.ordem = ordem;
  if (params.get("agrupar") === "responsavel") f.agrupar = "responsavel";
  return f;
}

/** Filtros → query string, só com o que difere do padrão (URL limpa abre o padrão). */
export function filtrosParaUrl(f: FiltrosDeTarefas): string {
  const p = new URLSearchParams();
  if (f.busca?.trim()) p.set("q", f.busca.trim());
  if (f.minhas) p.set("minhas", "1");
  if (f.atrasadas) p.set("atrasadas", "1");
  if (f.hoje) p.set("hoje", "1");
  if (f.semResponsavel) p.set("sem_resp", "1");
  if (f.responsavel) p.set("resp", f.responsavel);
  if (f.prioridades?.length) p.set("prio", f.prioridades.join(","));
  if (f.periodo) p.set("periodo", f.periodo);
  if (f.vinculo) p.set("vinculo", f.vinculo);
  if (f.funil) {
    p.set("funil", f.funil);
    if (f.etapa) p.set("etapa", f.etapa);
  }
  if (f.situacao && f.situacao !== "aberto") p.set("situacao", f.situacao);
  if (f.ordem && f.ordem !== "prazo") p.set("ordem", f.ordem);
  if (f.agrupar === "responsavel") p.set("agrupar", "responsavel");
  return p.toString();
}

/** Sem acento e sem caixa: "joão" acha "Joao". */
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** De que a tarefa é, pela régua da tela (negócio vence contato). */
export function vinculoDaTarefa(tarefa: Pick<Tarefa, "lead_id" | "contact_id">): Vinculo {
  if (tarefa.lead_id) return "negocio";
  if (tarefa.contact_id) return "contato";
  return "avulsa";
}

const UM_DIA_MS = 86_400_000;
const inicioDoDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function noPeriodo(tarefa: Pick<Tarefa, "due_date" | "status">, periodo: PeriodoDoPrazo, agora: Date): boolean {
  if (periodo === "sem_prazo") return !tarefa.due_date;
  if (!tarefa.due_date) return false;
  if (periodo === "vencidas") return estaAtrasada(tarefa, agora);
  const prazo = new Date(tarefa.due_date).getTime();
  const hoje = inicioDoDia(agora);
  if (periodo === "hoje") return prazo >= hoje && prazo < hoje + UM_DIA_MS;
  if (periodo === "amanha") return prazo >= hoje + UM_DIA_MS && prazo < hoje + 2 * UM_DIA_MS;
  return prazo >= hoje && prazo < hoje + 7 * UM_DIA_MS;
}

export interface ContextoDoRecorte {
  usuarioId: string | null | undefined;
  agora: Date;
}

/** Sem responsável e ainda pedindo ação: o "ninguém vai fazer isto". */
export function semResponsavel(tarefa: Pick<Tarefa, "assigned_to" | "status">): boolean {
  return !tarefa.assigned_to && !estaEncerrada(tarefa);
}

function passa(tarefa: Tarefa, f: FiltrosDeTarefas, ctx: ContextoDoRecorte): boolean {
  if (f.busca) {
    const alvo = normalizar(f.busca.trim());
    const onde = [tarefa.title, tarefa.description ?? "", tarefa.lead?.title ?? "", nomeDoContato(tarefa.contato) ?? ""];
    if (!onde.some((t) => normalizar(t).includes(alvo))) return false;
  }
  if (f.minhas && (!ctx.usuarioId || tarefa.assigned_to !== ctx.usuarioId)) return false;
  if (f.atrasadas && !estaAtrasada(tarefa, ctx.agora)) return false;
  if (f.hoje && faixaDePrazo(tarefa, ctx.agora) !== "hoje") return false;
  if (f.semResponsavel && !semResponsavel(tarefa)) return false;
  if (f.responsavel) {
    if (f.responsavel === "sem") {
      if (tarefa.assigned_to) return false;
    } else {
      const quem = f.responsavel === "eu" ? ctx.usuarioId : f.responsavel;
      if (!quem || tarefa.assigned_to !== quem) return false;
    }
  }
  if (f.prioridades?.length && !f.prioridades.includes(tarefa.priority)) return false;
  if (f.periodo && !noPeriodo(tarefa, f.periodo, ctx.agora)) return false;
  if (f.vinculo && vinculoDaTarefa(tarefa) !== f.vinculo) return false;
  if (f.funil && tarefa.lead?.pipeline_id !== f.funil) return false;
  if (f.funil && f.etapa && tarefa.lead?.stage_id !== f.etapa) return false;
  return true;
}

/** As tarefas que passam por TODOS os filtros (a situação já veio da rota). */
export function aplicarFiltros(tarefas: readonly Tarefa[], f: FiltrosDeTarefas, ctx: ContextoDoRecorte): Tarefa[] {
  return tarefas.filter((t) => passa(t, f, ctx));
}

export interface ContagensDosAtalhos {
  atrasadas: number;
  hoje: number;
  semResponsavel: number;
}

/**
 * As contagens olham o recorte SEM os atalhos: o número diz quantas o toque
 * vai mostrar com o resto dos filtros como está (a mesma régua do Funil).
 */
export function contagensDosAtalhos(tarefas: readonly Tarefa[], f: FiltrosDeTarefas, ctx: ContextoDoRecorte): ContagensDosAtalhos {
  // "Minhas" fica: é o recorte de quem olha, e "Atrasadas N" com "Minhas"
  // ligado tem de contar as MINHAS atrasadas, não as do time.
  const base = aplicarFiltros(tarefas, { ...f, atrasadas: undefined, hoje: undefined, semResponsavel: undefined }, ctx);
  let atrasadas = 0;
  let hoje = 0;
  let sem = 0;
  for (const t of base) {
    if (estaAtrasada(t, ctx.agora)) atrasadas += 1;
    if (faixaDePrazo(t, ctx.agora) === "hoje") hoje += 1;
    if (semResponsavel(t)) sem += 1;
  }
  return { atrasadas, hoje, semResponsavel: sem };
}

/** Quantos filtros DO PAINEL estão ligados (o número do botão "Filtros"). */
export function quantosNoPainel(f: FiltrosDeTarefas): number {
  return [
    f.responsavel,
    f.prioridades?.length ? f.prioridades : undefined,
    f.periodo,
    f.vinculo,
    f.funil,
    f.situacao && f.situacao !== "aberto" ? f.situacao : undefined,
  ].filter(Boolean).length;
}

const PESO_DA_PRIORIDADE: Record<PrioridadeDaTarefa, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const prazoMs = (t: Pick<Tarefa, "due_date">) => (t.due_date ? new Date(t.due_date).getTime() : Number.POSITIVE_INFINITY);
const criadaMs = (t: Pick<Tarefa, "created_at">) => new Date(t.created_at).getTime();

/** O comparador da ordem DENTRO do grupo. Empate cai no prazo e, depois, na mais nova. */
export function comparadorDasTarefas(ordem: OrdemDasTarefas = "prazo") {
  return (a: Tarefa, b: Tarefa): number => {
    if (ordem === "criacao") return criadaMs(b) - criadaMs(a);
    if (ordem === "prioridade") {
      const p = PESO_DA_PRIORIDADE[a.priority] - PESO_DA_PRIORIDADE[b.priority];
      if (p !== 0) return p;
    }
    // Sem prazo é +Infinito: vai para o fim sem caso especial.
    const pa = prazoMs(a);
    const pb = prazoMs(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return criadaMs(b) - criadaMs(a);
  };
}

/** A chave do grupo "sem responsável" no agrupamento por pessoa. */
export const SEM_RESPONSAVEL = "__sem__";

/**
 * Agrupa por responsável: quem está logado primeiro, depois os demais pelo
 * nome, e "sem responsável" por último (é o grupo que pede dono). O nome vem
 * de quem chama (`nomeDe`), para a regra não depender da lista de membros.
 */
export function agrupaPorResponsavel(
  tarefas: readonly Tarefa[],
  usuarioId: string | null | undefined,
  nomeDe: (id: string) => string,
): Array<{ chave: string; tarefas: Tarefa[] }> {
  const porDono = new Map<string, Tarefa[]>();
  for (const t of tarefas) {
    const chave = t.assigned_to ?? SEM_RESPONSAVEL;
    const atual = porDono.get(chave);
    if (atual) atual.push(t);
    else porDono.set(chave, [t]);
  }
  const peso = (chave: string) => (chave === usuarioId ? 0 : chave === SEM_RESPONSAVEL ? 2 : 1);
  return [...porDono.entries()]
    .sort(([a], [b]) => peso(a) - peso(b) || nomeDe(a).localeCompare(nomeDe(b), "pt-BR"))
    .map(([chave, lista]) => ({ chave, tarefas: lista }));
}

/** Os funis (e as etapas de cada um) que aparecem nas tarefas, para o painel oferecer. */
export function funisDasTarefas(tarefas: readonly Tarefa[]): Array<{ id: string; name: string; etapas: Array<{ id: string; name: string }> }> {
  const funis = new Map<string, { id: string; name: string; etapas: Map<string, string> }>();
  for (const t of tarefas) {
    const f = t.lead?.funil;
    if (!f) continue;
    const atual = funis.get(f.id) ?? { id: f.id, name: f.name, etapas: new Map<string, string>() };
    if (t.lead?.etapa) atual.etapas.set(t.lead.etapa.id, t.lead.etapa.name);
    funis.set(f.id, atual);
  }
  return [...funis.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((f) => ({ id: f.id, name: f.name, etapas: [...f.etapas].map(([id, name]) => ({ id, name })) }));
}

/**
 * O que o clique na tarefa abre: o DOSSIÊ do negócio (detalhes + conversa,
 * sem sair da tela) quando ela é de um negócio cujo funil a rota trouxe; a
 * EDIÇÃO da tarefa nos outros casos (avulsa, só de contato, ou negócio que a
 * pessoa não enxerga — o embutido vem nulo).
 */
export function destinoAoAbrir(
  tarefa: Pick<Tarefa, "lead">,
): { tipo: "dossie"; leadId: string; pipelineId: string } | { tipo: "edicao" } {
  const lead = tarefa.lead;
  if (lead?.id && lead.pipeline_id) return { tipo: "dossie", leadId: lead.id, pipelineId: lead.pipeline_id };
  return { tipo: "edicao" };
}
