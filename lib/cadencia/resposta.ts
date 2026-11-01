/**
 * O LEAD RESPONDEU À CADÊNCIA — quem atende a partir daqui.
 *
 * Chamado pela reatividade do follow-up (`lib/followup/reactivity.ts`) para cada
 * inscrição viva de cadência (`surface='cadence'`) do contato que escreveu. A
 * transição inteira mora numa função SQL atômica e idempotente
 * (`fn_cadencia_lead_respondeu`, migration 9018): cancela a inscrição e, se a
 * versão publicada manda a IA atender e as pré-condições passam, abre a
 * condução (`cadencia_conducoes`), fixa o agente e autoriza o contato.
 *
 * Daqui só sai o que a função não faz:
 *   - `modo='ia'`: nada. O `ai_agent.dispatch_requested` do mesmo inbound segue
 *     sozinho para o dreno do motor, que encontra a condução viva;
 *   - `modo='atendente'`: a conversa vai para uma pessoa — `triggerHandoff`
 *     (avisa o lead, silencia o bot, grava a passagem e o item da Central) mais
 *     o pedido de roteamento (`fn_request_channel_routing`).
 *
 * A regra é pura (interface estreita), o adapter supabase-js fica no fim.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { logger } from "@/lib/logger";
import { rpc } from "@/lib/supabase/rpc";

/** O que `fn_cadencia_lead_respondeu` devolve (jsonb). */
export interface RespostaDaCadencia {
  ja_encerrada: boolean;
  modo?: "ia" | "atendente";
  modo_conducao?: "automatico" | "assistido" | null;
  motivo?: string | null;
  conducao_id?: string | null;
  conversation_id?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
  pointer_id?: string | null;
}

/** O que a função gravou na 1ª aplicação (`followup_enrollment_events`). */
export interface RespostaRegistrada {
  modo: "ia" | "atendente" | null;
  motivo: string | null;
  event_log_id: string | null;
  conversation_id: string | null;
  lead_id: string | null;
  pointer_id: string;
}

export interface EntregaParaAtendente {
  organizationId: string;
  conversationId: string;
  leadId: string | null;
  pointerId: string | null;
  enrollmentId: string;
  /** Por que não foi a IA (`agente_indisponivel`, `contato_indisponivel`…), ou null se a cadência manda pessoa. */
  motivo: string | null;
}

export interface CadenciaRespostaDb {
  responderCadencia(orgId: string, enrollmentId: string, eventLogId: string): Promise<RespostaDaCadencia>;
  /** Lido só quando a função devolve `ja_encerrada` (retry do mesmo evento). */
  respostaRegistrada(orgId: string, enrollmentId: string): Promise<RespostaRegistrada | null>;
  entregarParaAtendente(entrega: EntregaParaAtendente): Promise<void>;
}

/**
 * Reage à resposta numa inscrição de cadência. Devolve `true` quando houve
 * transição agora.
 *
 * `entregues` deduplica a entrega por CONVERSA dentro do mesmo evento: gêmeos
 * de contato podem ter duas inscrições da mesma cadência, e a pessoa do outro
 * lado não pode receber dois "alguém vai te atender".
 *
 * Retry: o dispatcher só re-entrega o MESMO evento quando a tentativa anterior
 * falhou. Se ela falhou DEPOIS da função (na entrega), a função agora devolve
 * `ja_encerrada` — e sem o ramo abaixo a conversa ficaria sem ninguém. A
 * resposta registrada com o MESMO `event_log_id` e `modo='atendente'` é a prova
 * de que a transição é deste evento, e a entrega é refeita (at-least-once).
 */
export async function reagirNaCadencia(
  db: CadenciaRespostaDb,
  row: { id: string; organization_id: string },
  enrollmentId: string,
  entregues: Set<string>,
): Promise<boolean> {
  const org = row.organization_id;
  const r = await db.responderCadencia(org, enrollmentId, row.id);

  if (r.ja_encerrada) {
    const reg = await db.respostaRegistrada(org, enrollmentId);
    if (reg === null || reg.event_log_id !== row.id || reg.modo !== "atendente" || reg.conversation_id === null) {
      return false;
    }
    if (entregues.has(reg.conversation_id)) return false;
    entregues.add(reg.conversation_id);
    await db.entregarParaAtendente({
      organizationId: org,
      conversationId: reg.conversation_id,
      leadId: reg.lead_id,
      pointerId: reg.pointer_id,
      enrollmentId,
      motivo: reg.motivo,
    });
    return false;
  }

  if (r.modo === "ia") return true;

  // modo 'atendente' (ou ausente — na dúvida, uma pessoa).
  const conversationId = r.conversation_id ?? null;
  if (conversationId === null) {
    // Inscrição sem conversa (gatilho manual sem canal): não há onde entregar;
    // a inscrição já está cancelada e o inbound, se veio, já tem conversa própria.
    return true;
  }
  if (!entregues.has(conversationId)) {
    entregues.add(conversationId);
    await db.entregarParaAtendente({
      organizationId: org,
      conversationId,
      leadId: r.lead_id ?? null,
      pointerId: r.pointer_id ?? null,
      enrollmentId,
      motivo: r.motivo ?? null,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Adapter supabase-js (service role) — usado pela reatividade em produção.
// ---------------------------------------------------------------------------

function comoTexto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function createSupabaseCadenciaRespostaDb(admin: SupabaseClient): CadenciaRespostaDb {
  return {
    async responderCadencia(orgId, enrollmentId, eventLogId) {
      const { data, error } = await rpc(admin, "fn_cadencia_lead_respondeu", {
        p_org: orgId,
        p_enrollment: enrollmentId,
        p_event_id: eventLogId,
      });
      if (error) throw new Error(`fn_cadencia_lead_respondeu: ${error.message}`);
      return (data ?? { ja_encerrada: true }) as unknown as RespostaDaCadencia;
    },

    async respostaRegistrada(orgId, enrollmentId) {
      const { data: ev, error } = await admin
        .from("followup_enrollment_events")
        .select("payload")
        .eq("organization_id", orgId)
        .eq("enrollment_id", enrollmentId)
        .eq("idempotency_key", `cadencia-resposta:${enrollmentId}`)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ev) return null;
      const { data: e, error: eErr } = await admin
        .from("followup_enrollments")
        .select("conversation_id, lead_id, pointer_id")
        .eq("organization_id", orgId)
        .eq("id", enrollmentId)
        .maybeSingle();
      if (eErr) throw new Error(eErr.message);
      if (!e) return null;
      const payload = ((ev as { payload?: unknown }).payload ?? {}) as Record<string, unknown>;
      const modo = payload.modo === "ia" || payload.modo === "atendente" ? payload.modo : null;
      const enr = e as { conversation_id: string | null; lead_id: string | null; pointer_id: string };
      return {
        modo,
        motivo: comoTexto(payload.motivo),
        event_log_id: comoTexto(payload.event_log_id),
        conversation_id: enr.conversation_id,
        lead_id: enr.lead_id,
        pointer_id: enr.pointer_id,
      };
    },

    async entregarParaAtendente(entrega) {
      let nome: string | null = null;
      if (entrega.pointerId !== null) {
        const { data } = await admin
          .from("followup_flow_pointers")
          .select("name")
          .eq("organization_id", entrega.organizationId)
          .eq("id", entrega.pointerId)
          .maybeSingle();
        nome = (data as { name?: string } | null)?.name ?? null;
      }
      const motivoTexto = nome !== null ? `Lead respondeu à cadência «${nome}»` : "Lead respondeu à cadência";
      const resultado = await triggerHandoff({
        conversationId: entrega.conversationId,
        organizationId: entrega.organizationId,
        leadId: entrega.leadId,
        reason: "cadencia_lead_respondeu",
        origem: "cadencia",
        motivoTexto,
        tituloDaCentral: "Lead respondeu à cadência — assumir a conversa",
        // O lead respondeu a uma mensagem nossa: o allowlist de IA do canal não
        // pode impedir que uma PESSOA atenda.
        ignorarGateDeAllowlist: true,
        metadata: {
          pointer_id: entrega.pointerId,
          enrollment_id: entrega.enrollmentId,
          ...(entrega.motivo !== null ? { motivo: entrega.motivo } : {}),
        },
      });

      // Roteamento para um atendente: idempotente (índice único do evento) e
      // no-op quando a conversa já tem dono. Em org `manual` a conversa fica na
      // fila, com o item da Central.
      const { error: rotErr } = await rpc(admin, "fn_request_channel_routing", {
        p_org: entrega.organizationId,
        p_conversation: entrega.conversationId,
      });
      if (rotErr) throw new Error(`fn_request_channel_routing: ${rotErr.message}`);

      if (!resultado.triggered) {
        // Os "não" que sobram (pessoa já na conversa, silêncio, 5s de
        // idempotência) não pedem nada além do roteamento acima.
        logger.info("[cadencia] entrega ao atendente sem handoff", {
          conversation_id: entrega.conversationId,
          reason: resultado.reason,
        });
      }
    },
  };
}
