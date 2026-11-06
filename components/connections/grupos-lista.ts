/** Tipos e regras puras da lista de grupos (Canais › número › Grupos). */

export interface Grupo {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
  presente: boolean;
  /**
   * #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo".
   * Opcional de propósito: um servidor que ainda não atualizou não manda a
   * coluna, e "ausente" é a mesma coisa que desligada (a régua do servidor é
   * `=== true`, falha fechada).
   */
  iaResponde?: boolean;
  /** Do diretório do WhatsApp; ausentes em servidor antigo. `archived`/`pinned` `null` = desconhecido. */
  participantCount?: number | null;
  adminCount?: number;
  papel?: "dono" | "admin" | "membro" | null;
  isAnnounce?: boolean;
  tipo?: "grupo" | "comunidade" | "grupo_da_comunidade";
  archived?: boolean | null;
  pinned?: boolean | null;
}

export type FiltroDeTipo = "todos" | NonNullable<Grupo["tipo"]>;
export type AbaDeGrupos = "ativos" | "arquivados";

/** Busca insensível a maiúscula/minúscula e a acento: "grupo sao" acha "Grupo São". */
export function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Fixados, depois ligados, depois por nome. */
export function ordenarGrupos(a: Grupo, b: Grupo): number {
  return (
    Number(b.pinned === true) - Number(a.pinned === true) ||
    Number(b.enabled) - Number(a.enabled) ||
    (a.subject ?? "").localeCompare(b.subject ?? "", "pt-BR")
  );
}

export function filtrarGrupos(
  grupos: Grupo[],
  o: { busca: string; tipo: FiltroDeTipo; aba: AbaDeGrupos; semNome: string },
): Grupo[] {
  const alvo = normalizarBusca(o.busca);
  return grupos
    .filter((g) => (o.aba === "arquivados") === (g.archived === true))
    .filter((g) => o.tipo === "todos" || (g.tipo ?? "grupo") === o.tipo)
    .filter((g) => normalizarBusca(g.subject ?? o.semNome).includes(alvo))
    .sort(ordenarGrupos);
}

/** "Atualizado há X min" em minutos inteiros; `null` sem data. */
export function minutosDesde(iso: string | null, agora = Date.now()): number | null {
  if (!iso) return null;
  const ms = agora - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : null;
}
