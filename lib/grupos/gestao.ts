/**
 * Gestão de UM grupo de WhatsApp pelo painel da inbox: valida que o grupo é desta sessão, executa a
 * ação (pareado ou direto, `verdashGrupoAcao`), mantém o diretório em dia e audita sem telefones.
 * Quem pode chamar (papel) é decidido na rota, antes daqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { verdashGrupoAcao } from "@/lib/channels/verdash/client";
import { resolveVerdashCreds } from "@/lib/channels/verdash/credentials";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { GrupoAcaoError, type PedidoAoFzap } from "./acoes";
import { alternarGrupo, criarDepsDeGrupos, GrupoError, type DepsDeGrupos } from "./servico";

export interface PatchDoDiretorio {
  subject?: string;
  is_announce?: boolean;
  /** Soma ao `participant_count` (nunca abaixo de zero). */
  participantDelta?: number;
}

export interface DepsDeGestao extends DepsDeGrupos {
  /** O grupo tem linha no diretório OU na fila desta sessão e organização? */
  grupoDaSessao(org: string, sessionId: string, chatId: string): Promise<boolean>;
  ajustarDiretorio(org: string, sessionId: string, chatId: string, patch: PatchDoDiretorio): Promise<void>;
  apagarDoDiretorio(org: string, sessionId: string, chatId: string): Promise<void>;
  /** Resolve a credencial da sessão e executa. LANÇA `GrupoAcaoError`. */
  acao(org: string, sessionRef: string, entrada: Record<string, unknown>, chamada: PedidoAoFzap): Promise<unknown>;
}

interface EntradaDaAcao {
  organizationId: string;
  channelSessionId: string;
  /** Já validada por `montarChamada`; `entrada.groupChatId` é o JID. */
  entrada: Record<string, unknown>;
  chamada: PedidoAoFzap;
  actorUserId: string;
  requestId: string;
}

export async function executarAcaoDeGrupo(deps: DepsDeGestao, e: EntradaDaAcao): Promise<unknown> {
  const { organizationId: org, channelSessionId: sessionId, entrada } = e;
  const chatId = String(entrada.groupChatId);
  const acao = String(entrada.acao);

  const s = await deps.db.lerSessao(org, sessionId);
  if (!s) throw new GrupoError("sessao_nao_encontrada");
  // Só o canal pareado à Verdash sabe gerir grupo (edge `crm-grupo-acao` ou FZAP direto).
  if (s.provider !== "verdash" || s.groupsCapability === "none") throw new GrupoError("canal_sem_grupos");
  if (!(await deps.grupoDaSessao(org, sessionId, chatId))) throw new GrupoError("grupo_nao_encontrado");

  const dados = await deps.acao(org, s.sessionRef, entrada, e.chamada);
  // Daqui para baixo o WhatsApp JÁ mudou: falha local não vira erro (o retry bateria em 422 e o grupo
  // nunca seria desligado). Loga e responde ok; o próximo refresh do diretório corrige o resto.
  try {
    await efeitosLocais(deps, e, acao, chatId);
  } catch (err) {
    logger.warn("grupos: efeito local da ação falhou depois do WhatsApp aceitar", {
      acao,
      channelSessionId: sessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  return dados;
}

async function efeitosLocais(deps: DepsDeGestao, e: EntradaDaAcao, acao: string, chatId: string): Promise<void> {
  const { organizationId: org, channelSessionId: sessionId, entrada } = e;
  const telefones = Array.isArray(entrada.telefones) ? entrada.telefones.length : 0;
  // Ler o link também audita: ele dá entrada no grupo a quem o receber.
  if (acao !== "info") {
    await deps.audit({
      action: `channel.group_${acao}`,
      organizationId: org,
      actorUserId: e.actorUserId,
      resourceId: sessionId,
      requestId: e.requestId,
      // Sem telefones nem texto livre: só o que mudou e quantos.
      metadata: {
        channel_session_id: sessionId,
        group_chat_id: chatId,
        acao,
        ...(acao === "participantes" ? { operacao: entrada.operacao, quantidade: telefones } : {}),
        ...(typeof entrada.ligado === "boolean" ? { ligado: entrada.ligado } : {}),
        ...(acao === "mensagens_temporarias" ? { duracao: entrada.duracao } : {}),
        ...(acao === "link" ? { reset: entrada.reset === true } : {}),
      },
    });
  }

  if (acao === "nome") await deps.ajustarDiretorio(org, sessionId, chatId, { subject: String(entrada.nome).trim() });
  if (acao === "so_admins_enviam") await deps.ajustarDiretorio(org, sessionId, chatId, { is_announce: entrada.ligado === true });
  if (acao === "participantes" && (entrada.operacao === "add" || entrada.operacao === "remove")) {
    await deps.ajustarDiretorio(org, sessionId, chatId, { participantDelta: entrada.operacao === "add" ? telefones : -telefones });
  }
  if (acao === "sair") {
    await deps.apagarDoDiretorio(org, sessionId, chatId);
    const ligado = (await deps.db.listarLinhas(org, sessionId)).some((l) => l.group_chat_id === chatId && l.enabled);
    if (ligado) {
      await alternarGrupo(deps, {
        organizationId: org, channelSessionId: sessionId, groupChatId: chatId,
        subject: null, ligar: false, actorUserId: e.actorUserId, requestId: e.requestId,
      });
    }
  }
}

export function criarDepsDeGestao(admin: SupabaseClient = createAdminClient()): DepsDeGestao {
  return {
    ...criarDepsDeGrupos(admin),
    async grupoDaSessao(org, sessionId, chatId) {
      for (const tabela of ["channel_session_group_directory", "channel_session_groups"]) {
        const { data, error } = await admin
          .from(tabela)
          .select("group_chat_id")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("group_chat_id", chatId)
          .limit(1);
        if (error) throw error;
        if (data?.length) return true;
      }
      return false;
    },
    async ajustarDiretorio(org, sessionId, chatId, patch) {
      const { subject, is_announce: announce, participantDelta } = patch;
      const mudanca: Record<string, unknown> = {};
      if (subject !== undefined) mudanca.subject = subject;
      if (announce !== undefined) mudanca.is_announce = announce;
      if (participantDelta !== undefined) {
        const { data } = await admin
          .from("channel_session_group_directory")
          .select("participant_count")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("group_chat_id", chatId)
          .maybeSingle();
        // Sem contagem conhecida não há o que somar.
        if (data?.participant_count == null) {
          if (!Object.keys(mudanca).length) return;
        } else {
          mudanca.participant_count = Math.max(0, (data.participant_count as number) + participantDelta);
        }
      }
      const { error } = await admin.from("channel_session_group_directory").update(mudanca)
        .eq("organization_id", org).eq("channel_session_id", sessionId).eq("group_chat_id", chatId);
      if (error) throw error;
    },
    async apagarDoDiretorio(org, sessionId, chatId) {
      const { error } = await admin
        .from("channel_session_group_directory")
        .delete()
        .eq("organization_id", org)
        .eq("channel_session_id", sessionId)
        .eq("group_chat_id", chatId);
      if (error) throw error;
    },
    async acao(org, sessionRef, entrada, chamada) {
      const creds = await resolveVerdashCreds(admin, { organizationId: org, instanceName: sessionRef });
      if (!creds) throw new GrupoAcaoError("instancia_desconectada");
      return verdashGrupoAcao(creds, entrada, chamada);
    },
  };
}
