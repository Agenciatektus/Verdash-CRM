/**
 * Grupos de WhatsApp na inbox: qual grupo de cada número entra no CRM.
 * Spec: docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md
 *
 * O filtro do WhatsApp é tudo ou nada por número: com pelo menos um grupo ligado ele recebe
 * todos (e a entrada descarta os não escolhidos); desligar o ÚLTIMO volta a ignorar. A troca
 * do filtro precisa ser CONFIRMADA antes de gravar "ligado": nunca fica ligado sem estar.
 *
 * O filtro se AUTOCORRIGE: todo "ligar" confere o filtro (não só o primeiro), e a conexão e a
 * reconexão do número o ressincronizam a partir de `channel_session_groups`
 * (`sincronizarRecebimentoDeGrupos`, em `sincronizar-filtro.ts`). A conferência é barata porque o transporte lê antes
 * e só escreve quando o valor difere — sem escrita e sem reinício de sessão quando já está certo.
 */
import { modoDaIa, type IaModo } from "@/lib/grupos/ia-no-grupo";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit as auditReal } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { capabilitiesOf, getAdapter } from "@/lib/channels";
import { resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type { ChannelGroup, ChannelProvider } from "@/lib/channels/types";
import { logger } from "@/lib/logger";

export class GrupoError extends Error {
  constructor(
    public readonly code: "sessao_nao_encontrada" | "canal_sem_grupos" | "filtro_nao_confirmado" | "grupo_desligado",
  ) {
    super(code);
    this.name = "GrupoError";
  }
}

// Aceita o formato atual (`<digitos>@g.us`) e o legado medido no servidor real
// (`<digitos>-<digitos>@g.us`) — a régua não é a forma nova, é a que o WhatsApp
// de verdade envia hoje.
const chatIdDeGrupo = z.string().regex(/^[\d-]+@g\.us$/);

export interface GrupoDoNumero {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
  /**
   * O WhatsApp devolveu este grupo agora? `false` = ligado no banco mas o
   * número já saiu dele (ou o grupo sumiu) — um ÓRFÃO. Sem carregar isto na
   * lista, o grupo desaparece da tela assim que `listGroups` para de
   * devolvê-lo, e o botão "desligar" só existe para quem a tela mostra: o
   * grupo fica preso ligado para sempre.
   */
  presente: boolean;
  /**
   * #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo".
   *
   * Ela só existe dentro de um grupo já LIGADO (a rota recusa `grupo_desligado`
   * para o resto) porque é a segunda de DUAS decisões: entrar na inbox é o que
   * `enabled` faz, e mexe no filtro do WhatsApp; responder é o que esta faz, e
   * é local. O padrão é `false` — o estado de quem nunca tocou em nada continua
   * sendo a IA calada em grupo.
   */
  iaResponde: boolean;
  /** 9224 — o modo da IA no grupo; `iaResponde` é o espelho (`iaModo !== "off"`). */
  iaModo: IaModo;
  /** Do diretório (cache do WhatsApp). `archived`/`pinned`: `null` = ainda não se sabe. */
  participantCount: number | null;
  adminCount: number;
  papel: "dono" | "admin" | "membro" | null;
  isAnnounce: boolean;
  tipo: "grupo" | "comunidade" | "grupo_da_comunidade";
  archived: boolean | null;
  pinned: boolean | null;
}

export interface ListaDeGrupos {
  grupos: GrupoDoNumero[];
  /** Quando o diretório foi atualizado pela última vez. */
  atualizadoEm: string | null;
  /** O WhatsApp não respondeu agora e a lista vem do cache. */
  desatualizado: boolean;
}

/** Até quando o diretório vale sem perguntar ao WhatsApp. */
export const VALIDADE_DO_DIRETORIO_MS = 10 * 60_000;

export interface LinhaDoDiretorio {
  group_chat_id: string;
  subject: string | null;
  participant_count: number | null;
  admin_count: number;
  papel: GrupoDoNumero["papel"];
  is_announce: boolean;
  tipo: GrupoDoNumero["tipo"];
  archived: boolean | null;
  pinned: boolean | null;
  refreshed_at: string;
}

/** Linha sem `ia_modo` (banco antes da 9224): vale o boolean antigo. */
function modoDaLinha(l: LinhaDeGrupo | undefined): IaModo {
  // Mesma régua do ingest e do drain: `ia_responde` desligado manda.
  return l?.ia_responde !== true ? "off" : l.ia_modo ? modoDaIa(l.ia_modo) : "todas";
}

interface LinhaDeGrupo {
  group_chat_id: string;
  subject: string | null;
  enabled: boolean;
  enabled_at: string | null;
  /** #2729 — a chave por grupo; `null` nunca vem do banco (`not null`). */
  ia_responde: boolean | null;
  /** 9224 — `off` | `chamada` | `todas`; `null` só em banco sem a migration. */
  ia_modo?: string | null;
}

/**
 * O que a tela da fila grava: a chave da IA NÃO entra aqui. Ela nasce no
 * default da coluna (desligada) e só muda pela `definirIa` — ligar um grupo
 * não pode ligar a IA junto, e desligar não pode desligar (senão re-ligar o
 * grupo silenciosamente apagaria a escolha do operador).
 */
type LinhaDeGravacao = Omit<LinhaDeGrupo, "ia_responde"> & { enabled_by_user_id: string | null };

export interface GruposDb {
  lerSessao(
    org: string,
    sessionId: string,
  ): Promise<{ provider: ChannelProvider; sessionRef: string; groupsCapability: "full" | "limited" | "none" } | null>;
  listarLinhas(org: string, sessionId: string): Promise<LinhaDeGrupo[]>;
  lerDiretorio(org: string, sessionId: string): Promise<LinhaDoDiretorio[]>;
  /**
   * Upsert de tudo o que o WhatsApp devolveu SEM tocar em archived/pinned (o espelho vem por
   * evento) e apaga do diretório o que ele não devolveu mais.
   */
  /** Apaga só o que é mais velho que `corteIso` (o INÍCIO desta busca), para não apagar o que outra busca simultânea acabou de gravar. */
  gravarDiretorio(org: string, sessionId: string, grupos: ChannelGroup[], agoraIso: string, corteIso: string): Promise<void>;
  contarLigados(org: string, sessionId: string): Promise<number>;
  gravarLinha(org: string, sessionId: string, row: LinhaDeGravacao): Promise<{ id: string }>;
  /**
   * #2729 — grava a chave por grupo SEM passar pelo transporte: atualiza só
   * linha LIGADA (um `update ... where enabled = true`). `null` = o grupo não
   * está na fila, e quem chama recusa com `grupo_desligado`.
   */
  definirIa(org: string, sessionId: string, groupChatId: string, modo: IaModo): Promise<{ id: string } | null>;
}

export interface DepsDeGrupos {
  db: GruposDb;
  listGroups(provider: ChannelProvider, sessionRef: string, organizationId: string): Promise<ChannelGroup[]>;
  /**
   * PODE LANÇAR (timeout/rede) mesmo declarando `Promise<boolean>` — o contrato
   * é "eu tento" e a exceção é um resultado, não um bug de tipo. Quem chama
   * (`alternarGrupo`) trata a exceção exatamente como `false`: nada fica ligado
   * sem estar confirmado.
   */
  setGroupIntake(provider: ChannelProvider, sessionRef: string, receive: boolean): Promise<boolean>;
  audit(entry: {
    action: string;
    organizationId: string;
    actorUserId: string;
    resourceId: string;
    requestId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  agora(): Date;
}

async function sessaoComGrupos(deps: DepsDeGrupos, org: string, sessionId: string) {
  const s = await deps.db.lerSessao(org, sessionId);
  if (!s) throw new GrupoError("sessao_nao_encontrada");
  if (s.groupsCapability === "none") throw new GrupoError("canal_sem_grupos");
  return s;
}

export async function listarGruposDoNumero(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string;
    /** `?refresh=1`: pergunta ao WhatsApp e espera. */
    refresh?: boolean;
    /** Agenda trabalho para depois da resposta (`after()` da rota). Sem isto, o refresh de cache velho é síncrono. */
    agendar?: (tarefa: () => Promise<void>) => void;
  },
): Promise<ListaDeGrupos> {
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  let cache = await deps.db.lerDiretorio(e.organizationId, e.channelSessionId);
  const aoVivo = async () => {
    const corteIso = deps.agora().toISOString();
    const doCanal = await deps.listGroups(s.provider, s.sessionRef, e.organizationId);
    // Lista vazia com cache cheio é envelope estranho ou sessão meio conectada: não apaga o diretório.
    if (doCanal.length === 0 && cache.length > 0) throw new Error("lista_de_grupos_vazia");
    await deps.db.gravarDiretorio(e.organizationId, e.channelSessionId, doCanal, deps.agora().toISOString(), corteIso);
  };
  let desatualizado = false;
  const maisNovo = () => cache.reduce((m, l) => (l.refreshed_at > m ? l.refreshed_at : m), "");
  const idade = () => deps.agora().getTime() - new Date(maisNovo()).getTime();
  const velho = () => idade() >= VALIDADE_DO_DIRETORIO_MS;
  // `?refresh=1` em laço não pode virar um /group/list de vários MB por clique: 30 s entre buscas forçadas.
  if (e.refresh && cache.length > 0 && idade() < 30_000) e = { ...e, refresh: false };

  if (cache.length > 0 && !e.refresh && velho() && e.agendar) {
    // Velho: responde com o que tem e atualiza depois.
    e.agendar(async () => {
      try {
        await aoVivo();
      } catch (err) {
        logger.warn("grupos: o refresh em segundo plano falhou", {
          channelSessionId: e.channelSessionId,
          causa: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } else if (cache.length === 0 || e.refresh || velho()) {
    try {
      await aoVivo();
      cache = await deps.db.lerDiretorio(e.organizationId, e.channelSessionId);
    } catch (err) {
      if (cache.length === 0) throw err;
      desatualizado = true; // o cache serve melhor que um erro.
    }
  }

  const gravados = await deps.db.listarLinhas(e.organizationId, e.channelSessionId);
  const porId = new Map(gravados.map((l) => [l.group_chat_id, l]));
  const daLista: GrupoDoNumero[] = cache.map((g) => {
    const l = porId.get(g.group_chat_id);
    porId.delete(g.group_chat_id); // o que sobrar no Map depois disto é órfão.
    return {
      chatId: g.group_chat_id,
      subject: g.subject ?? l?.subject ?? null,
      enabled: l?.enabled ?? false,
      enabledAt: l?.enabled_at ?? null,
      presente: true,
      // #2729: `l?.ia_responde ?? false` — grupo sem linha não tem como ter
      // a chave ligada, e `false` é o default da coluna (0653).
      iaResponde: l?.ia_responde === true,
      iaModo: modoDaLinha(l),
      participantCount: g.participant_count,
      adminCount: g.admin_count,
      papel: g.papel,
      isAnnounce: g.is_announce,
      tipo: g.tipo,
      archived: g.archived,
      pinned: g.pinned,
    };
  });
  // Órfãos: LIGADOS no banco, mas o WhatsApp não devolveu mais (o número saiu
  // do grupo, ou o grupo deixou de existir). Uma linha desligada que sumiu não
  // precisa aparecer — não há nada para desligar; uma linha LIGADA que sumiu
  // precisa, senão ela nunca mais pode ser desligada pela tela.
  const orfaos: GrupoDoNumero[] = [...porId.values()]
    .filter((l) => l.enabled)
    .map((l) => ({
      chatId: l.group_chat_id,
      subject: l.subject,
      enabled: l.enabled,
      enabledAt: l.enabled_at,
      presente: false,
      // Órfão LIGADO traz a chave junto: a IA pode estar respondendo num grupo
      // que o número deixou, e a tela tem de poder calá-la.
      iaResponde: l.ia_responde === true,
      iaModo: modoDaLinha(l),
      participantCount: null,
      adminCount: 0,
      papel: null,
      isAnnounce: false,
      tipo: "grupo" as const,
      archived: null,
      pinned: null,
    }));
  return { grupos: [...daLista, ...orfaos], atualizadoEm: cache.length ? maisNovo() : null, desatualizado };
}

/**
 * Concorrência: dois gestores trocando o MESMO número ao mesmo tempo não têm
 * trava (não há transação através do PostgREST). Não precisa: todo LIGAR
 * reconfere o filtro (idempotente no transporte — lê antes, escreve só se
 * difere), e o DESLIGAR decide pelo que já está gravado. Um intercalamento
 * ruim é corrigido pelo próximo ligar ou pela próxima (re)conexão do número.
 */
export async function alternarGrupo(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string;
    groupChatId: string;
    subject: string | null;
    ligar: boolean;
    actorUserId: string;
    requestId: string;
  },
): Promise<{ enabled: boolean }> {
  chatIdDeGrupo.parse(e.groupChatId);
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);

  if (e.ligar) return ligarGrupo(deps, s, e);
  return desligarGrupo(deps, s, e);
}

type SessaoComGrupos = Awaited<ReturnType<typeof sessaoComGrupos>>;
interface AlternarInput {
  organizationId: string;
  channelSessionId: string;
  groupChatId: string;
  subject: string | null;
  actorUserId: string;
  requestId: string;
}

/**
 * LIGAR: confirma o filtro ANTES de gravar — nunca fica "ligado" no banco sem
 * estar ligado de verdade no WhatsApp (invariante do serviço).
 *
 * O filtro é conferido em TODO ligar, não só no primeiro. Antes, com outro
 * grupo já ligado o filtro não era tocado — e um filtro que derivou (sessão
 * recriada depois de arquivar, volume do provedor perdido) nunca mais se curava:
 * o banco dizia "ligado" e nenhuma mensagem de grupo chegava. A conferência
 * não custa reinício de sessão: o transporte só escreve quando o valor
 * atual difere.
 */
async function ligarGrupo(deps: DepsDeGrupos, s: SessaoComGrupos, e: AlternarInput): Promise<{ enabled: boolean }> {
  // `setGroupIntake` pode LANÇAR (timeout, rede) em vez de resolver `false` —
  // as duas coisas significam a mesma coisa aqui: sem confirmação, nada liga.
  let confirmou: boolean;
  try {
    confirmou = await deps.setGroupIntake(s.provider, s.sessionRef, true);
  } catch {
    confirmou = false;
  }
  if (!confirmou) throw new GrupoError("filtro_nao_confirmado");
  const agora = deps.agora().toISOString();
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: true,
    enabled_at: agora,
    enabled_by_user_id: e.actorUserId,
  });
  await deps.audit({
    action: "channel.group_enabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.groupChatId, filtro_confirmado: true },
  });
  return { enabled: true };
}

/**
 * DESLIGAR: grava a linha PRIMEIRO, e só DEPOIS decide o filtro pela
 * contagem já gravada (I1). Duas razões, uma escrita:
 *
 *  - Escrita antes: se `gravarLinha` falhar, o erro sobe puro e o WhatsApp
 *    nunca foi tocado — não existe mais o caminho em que o filtro desliga e a
 *    linha fica presa "ligada" porque a escrita quebrou depois.
 *  - Recontar DEPOIS da escrita (em vez de excluir o alvo da contagem ANTES)
 *    resolve o bug de C1 de graça: desligar um grupo que já estava desligado
 *    é idempotente na escrita, e a recontagem seguinte reflete o estado REAL
 *    (outro grupo ainda ligado não some da conta) — sem precisar perguntar
 *    "o alvo já estava ligado?" à parte.
 *
 * Se a recontagem apontar zero ligados, tenta desligar o filtro. Uma falha
 * AQUI (recusa ou exceção) NÃO sobe para quem chamou: a linha já está
 * correta (o grupo está desligado no banco), e deixar o filtro ligado é a
 * direção segura — o ingest descarta mensagem de grupo não escolhido de
 * qualquer forma, então o pior efeito é barulho a mais, nunca vazamento. A
 * falha vira log estruturado e entra no metadata da auditoria, para dar para
 * achar depois.
 */
async function desligarGrupo(deps: DepsDeGrupos, s: SessaoComGrupos, e: AlternarInput): Promise<{ enabled: boolean }> {
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: false,
    enabled_at: null,
    enabled_by_user_id: null,
  });
  const restantes = await deps.db.contarLigados(e.organizationId, e.channelSessionId);
  const precisaDesligarFiltro = restantes === 0;
  let filtroDesligado: boolean | null = null;
  let motivoFalhaDoFiltro: string | null = null;
  if (precisaDesligarFiltro) {
    try {
      filtroDesligado = await deps.setGroupIntake(s.provider, s.sessionRef, false);
      if (!filtroDesligado) motivoFalhaDoFiltro = "recusado_pelo_whatsapp";
    } catch (err) {
      filtroDesligado = false;
      motivoFalhaDoFiltro = err instanceof Error ? err.message : String(err);
    }
    if (!filtroDesligado) {
      logger.warn("grupos: não deu para desligar o filtro de recebimento depois de desligar o último grupo", {
        organizationId: e.organizationId,
        channelSessionId: e.channelSessionId,
        groupChatId: e.groupChatId,
        causa: motivoFalhaDoFiltro,
      });
    }
  }
  await deps.audit({
    action: "channel.group_disabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: {
      channel_session_id: e.channelSessionId,
      group_chat_id: e.groupChatId,
      filtro_trocado: precisaDesligarFiltro,
      filtro_desligado: filtroDesligado,
      motivo_falha_do_filtro: motivoFalhaDoFiltro,
    },
  });
  return { enabled: false };
}

/**
 * #2729 — a segunda chave, POR GRUPO: "Permitir que a IA responda neste grupo".
 *
 * Ela é o oposto de `alternarGrupo` em tudo o que importa:
 *
 *  - NÃO mexe no transporte. Não há filtro a confirmar, não há sessão a
 *    reiniciar, não há contagem a recontar: é uma preferência nossa, não do
 *    WhatsApp. Por isso não há confirmação de volume na tela — ligar um grupo
 *    muda o que o número RECEBE; ligar a IA muda quem RESPONDE, só nos
 *    grupos já recebidos.
 *  - só existe para grupo LIGADO. Sem linha na fila não há mensagem nossa na
 *    inbox, logo não há nada para a IA responder — liberar seria uma chave que
 *    não liga nada, e uma chave que não liga nada é mentira na tela.
 *  - não zera nem renasce com ligar/desligar o grupo (`LinhaDeGravacao`): a
 *    escolha do operador sobrevive a uma reconexão do número.
 *
 * As proteções de envio (janela de 24h, ritmo, teto diário, silêncio
 * pós-handoff, elegibilidade) continuam valendo: elas moram no turno, depois
 * desta decisão, e nada aqui as contorna.
 */
export async function definirIaDoGrupo(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string;
    groupChatId: string;
    iaModo: IaModo;
    actorUserId: string;
    requestId: string;
  },
): Promise<{ ia_responde: boolean; ia_modo: IaModo }> {
  chatIdDeGrupo.parse(e.groupChatId);
  await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);

  const row = await deps.db.definirIa(e.organizationId, e.channelSessionId, e.groupChatId, e.iaModo);
  if (!row) throw new GrupoError("grupo_desligado");
  await deps.audit({
    action: e.iaModo !== "off" ? "channel.group_ai_enabled" : "channel.group_ai_disabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: {
      channel_session_id: e.channelSessionId,
      group_chat_id: e.groupChatId,
      ia_responde: e.iaModo !== "off",
      ia_modo: e.iaModo,
    },
  });
  return { ia_responde: e.iaModo !== "off", ia_modo: e.iaModo };
}

/** Dependências reais. `admin` é service role: TODA consulta filtra `organization_id`. */
export function criarDepsDeGrupos(admin: SupabaseClient): DepsDeGrupos {
  return {
    db: {
      async lerSessao(org, sessionId) {
        const { data } = await admin
          .from("channel_sessions")
          .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
          .eq("organization_id", org)
          .eq("id", sessionId)
          .maybeSingle();
        if (!data) return null;
        const ref = data as unknown as ChannelSessionRef & { provider: ChannelProvider };
        return { provider: ref.provider, sessionRef: resolveSessionRef(ref), groupsCapability: capabilitiesOf(ref.provider).groups };
      },
      async listarLinhas(org, sessionId) {
        const { data } = await admin
          .from("channel_session_groups")
          .select("group_chat_id, subject, enabled, enabled_at, ia_responde, ia_modo")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId);
        return (data ?? []) as LinhaDeGrupo[];
      },
      async lerDiretorio(org, sessionId) {
        const { data, error } = await admin
          .from("channel_session_group_directory")
          .select("group_chat_id, subject, participant_count, admin_count, papel, is_announce, tipo, archived, pinned, refreshed_at")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId);
        if (error) throw error;
        return (data ?? []) as LinhaDoDiretorio[];
      },
      async gravarDiretorio(org, sessionId, grupos, agoraIso, corteIso) {
        // Sem archived/pinned/archived_changed_at no objeto: o upsert não os sobrescreve.
        const linhas = grupos.map((g) => ({
          organization_id: org,
          channel_session_id: sessionId,
          group_chat_id: g.chatId,
          subject: g.subject,
          participant_count: g.participantCount ?? null,
          admin_count: g.adminCount ?? 0,
          papel: g.papel ?? null,
          is_announce: g.isAnnounce ?? false,
          tipo: g.tipo ?? "grupo",
          refreshed_at: agoraIso,
        }));
        for (let i = 0; i < linhas.length; i += 200) {
          const { error } = await admin
            .from("channel_session_group_directory")
            .upsert(linhas.slice(i, i + 200), { onConflict: "channel_session_id,group_chat_id" });
          if (error) throw error;
        }
        // O que o WhatsApp não devolveu mais sai: o corte é o INÍCIO desta busca, então o que
        // esta ou outra busca simultânea gravou depois fica (evita lista de ids na URL).
        const { error } = await admin
          .from("channel_session_group_directory")
          .delete()
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .lt("refreshed_at", corteIso);
        if (error) throw error;
      },
      async contarLigados(org, sessionId) {
        const { count } = await admin
          .from("channel_session_groups")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("enabled", true);
        return count ?? 0;
      },
      async gravarLinha(org, sessionId, row) {
        const { data, error } = await admin
          .from("channel_session_groups")
          .upsert({ organization_id: org, channel_session_id: sessionId, ...row }, { onConflict: "organization_id,channel_session_id,group_chat_id" })
          .select("id")
          .single();
        if (error) throw error;
        return data as { id: string };
      },
      async definirIa(org, sessionId, groupChatId, modo) {
        // O `enabled = true` no WHERE é o que faz a atualização devolver
        // `null` para grupo FORA da fila (sem linha, ou linha desligada) — é a
        // régua do banco por trás do `grupo_desligado` (#2729). A coluna não
        // nasce no upsert da tela (`LinhaDeGravacao`): ligar o grupo não liga
        // a IA junto, e desligar não a apaga.
        const { data, error } = await admin
          .from("channel_session_groups")
          .update({ ia_modo: modo, ia_responde: modo !== "off" })
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("group_chat_id", groupChatId)
          .eq("enabled", true)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        return data as { id: string } | null;
      },
    },
    async listGroups(provider, sessionRef, organizationId) {
      const adapter = getAdapter(provider);
      if (!adapter.listGroups) throw new GrupoError("canal_sem_grupos");
      return adapter.listGroups({ sessionRef, organizationId });
    },
    async setGroupIntake(provider, sessionRef, receive) {
      const adapter = getAdapter(provider);
      return adapter.setGroupIntake ? adapter.setGroupIntake({ sessionRef, receive }) : false;
    },
    async audit(entry) {
      await auditReal({
        action: entry.action as AuditAction,
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId,
        resourceType: "channel_session_group",
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      });
    },
    agora: () => new Date(),
  };
}
