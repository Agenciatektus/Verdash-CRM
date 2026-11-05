/**
 * As abas do app de celular (abaixo de 760px) e o que cada rota significa nele.
 * Puro: sem React, para o teste conferir a regra sem montar tela.
 *
 * Enquanto Funil, Tarefas, Avisos e Mais não têm tela própria (M3/M4), cada aba
 * leva para a tela que o CRM já tem.
 */

export type AbaDoCelular = "conversas" | "funil" | "tarefas" | "avisos" | "mais";

/** Onde cada aba começa. "Mais" abre o menu, não uma rota. */
export const RAIZ_DA_ABA: Record<Exclude<AbaDoCelular, "mais">, string> = {
  conversas: "/app/inbox",
  funil: "/app/kanban",
  tarefas: "/app/tasks",
  avisos: "/app/ai/inbox",
};

const dentro = (rota: string, base: string) => rota === base || rota.startsWith(`${base}/`);

/** A aba acesa numa rota. O que não é das quatro primeiras é do "Mais". */
export function abaDaRota(rota: string): AbaDoCelular {
  if (dentro(rota, "/app/inbox")) return "conversas";
  if (dentro(rota, "/app/kanban") || dentro(rota, "/app/pipelines") || dentro(rota, "/app/leads")) return "funil";
  if (dentro(rota, "/app/tasks") || dentro(rota, "/app/agenda")) return "tarefas";
  if (dentro(rota, "/app/ai/inbox")) return "avisos";
  return "mais";
}

/** A rota é o começo de uma aba? Lá vai o cabeçalho grande; nas outras, a barra com voltar. */
export function ehRaizDeAba(rota: string): boolean {
  return Object.values(RAIZ_DA_ABA).includes(rota);
}

/**
 * Para onde o voltar leva quem chegou por link (sem tela do app atrás). Uma tela de
 * Ajustes volta à lista de seções (`/app/settings`), uma do Agente de IA ao hub
 * (`/app/ai`); o resto do "Mais" volta ao
 * começo do app, e as outras abas ao começo delas.
 */
export function voltarDaRota(rota: string): string {
  const aba = abaDaRota(rota);
  if (aba !== "mais") return RAIZ_DA_ABA[aba];
  if (rota.startsWith("/app/settings/")) return "/app/settings";
  // As telas do Agente de IA voltam ao hub dele (`NavHub`), como Ajustes.
  return rota.startsWith("/app/ai/") ? "/app/ai" : "/app";
}

/** A conversa aberta: a Inbox com `?id=` ou `/app/inbox/<id>`. Ela desenha a própria barra. */
export function conversaAberta(rota: string, idNaUrl: string | null): boolean {
  return /^\/app\/inbox\/[^/]+$/.test(rota) || (rota === "/app/inbox" && !!idNaUrl);
}

/** O editor de um fluxo (follow-up ou atendimento): o canvas pede a tela inteira. */
export function editorDeFluxo(rota: string): boolean {
  return /^\/app\/ai\/(followups|atendimento)\/(?!enrollments$)[^/]+$/.test(rota);
}

/** Tela cheia: sem barra inferior (a conversa, a ficha do lead e o editor de fluxo). */
export function ehTelaCheia(rota: string, idNaUrl: string | null): boolean {
  return conversaAberta(rota, idNaUrl) || /^\/app\/leads\/[^/]+$/.test(rota) || editorDeFluxo(rota);
}

/** O que a folha "Criar" oferece (as opções do protótipo, por tela). */
export type OpcaoDeCriar = "conversa" | "contato" | "lead" | "tarefa" | "compromisso";

/**
 * As opções da folha "Criar" do FAB "+", na ordem do protótipo. Sem opções, sem FAB.
 * Conversas: tudo; Funil: lead, contato, tarefa; Tarefas: tarefa, compromisso, lead.
 */
export function opcoesDeCriar(rota: string): OpcaoDeCriar[] {
  if (rota === "/app/inbox") return ["conversa", "contato", "lead", "tarefa", "compromisso"];
  if (rota === "/app/kanban" || /^\/app\/pipelines\/[^/]+$/.test(rota)) return ["lead", "contato", "tarefa"];
  if (rota === "/app/tasks") return ["tarefa", "compromisso", "lead"];
  return [];
}

/**
 * Para onde cada opção leva: a tela que já cria aquilo, com `?criar=1` (ver
 * `usePedidoDeCriar`). O lead vai para o funil aberto, ou para o funil padrão. `search` é a query atual (a
 * tarefa da conversa aberta a usa).
 */
export function destinoDeCriar(opcao: OpcaoDeCriar, rota: string, funilPadrao: string | null, search = ""): string {
  if (opcao === "conversa") return "/app/contacts";
  if (opcao === "contato") return "/app/contacts?criar=1";
  if (opcao === "tarefa") {
    // Com a conversa aberta a tarefa é DELA (presa ao contato e ao negócio): fica na tela e abre o diálogo,
    // mantendo os filtros da URL. Em /app/tasks?criar=1 ela nasceria solta.
    const params = new URLSearchParams(search);
    if (!conversaAberta(rota, params.get("id"))) return "/app/tasks?criar=1";
    params.set("tarefa", "1");
    return `${rota}?${params.toString()}`;
  }
  if (opcao === "compromisso") return "/app/agenda?criar=1";
  if (/^\/app\/pipelines\/[^/]+$/.test(rota)) return `${rota}?criar=1`;
  return funilPadrao ? `/app/pipelines/${funilPadrao}?criar=1` : "/app/kanban";
}

/**
 * A tela de que cada opção depende: sem ela no menu do vínculo (papel, interface,
 * módulos e capacidades, a MESMA regra da busca: `searchable`), a opção não aparece.
 * "Nova conversa" começa em Contatos, mas é da Inbox: precisa das duas.
 */
const TELAS_DA_OPCAO: Record<OpcaoDeCriar, string[]> = {
  conversa: ["/app/inbox", "/app/contacts"],
  contato: ["/app/contacts"],
  lead: ["/app/kanban"],
  tarefa: ["/app/tasks"],
  compromisso: ["/app/agenda"],
};

export function opcoesPermitidas(opcoes: OpcaoDeCriar[], telasVisiveis: ReadonlySet<string>): OpcaoDeCriar[] {
  return opcoes.filter((o) => TELAS_DA_OPCAO[o].every((href) => telasVisiveis.has(href)));
}
