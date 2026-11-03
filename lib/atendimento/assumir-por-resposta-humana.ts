/**
 * Quem responde pelo CRM passa a ser o responsável pela conversa (e pelo negócio aberto sem dono).
 *
 * Só liga em organização com `settings.routing.handoff_return_after_minutes` definido: conversa
 * com `assignee_kind='user'` veta a IA antes do gate, e quem devolve é o cron `handoff-devolucao`,
 * que só roda com esse prazo. Sem ele, nada muda (o silêncio de `manual_reply_silence_minutes`
 * continua sendo o único freio, como antes).
 *
 * Reusa `fn_conversation_assign` (conversa) e `resolveOwnerPatch` (negócio); não há caminho paralelo.
 * Resposta pelo celular (`external_device`) não passa por aqui: não identifica a pessoa.
 * Nunca lança: falhar em assumir não pode derrubar o envio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerPrazoDeDevolucaoMinutos } from "@/lib/escalacao/devolucao-automatica";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import { logger } from "@/lib/logger";

export const MOTIVO_RESPOSTA_HUMANA = "resposta_humana_crm";

export async function assumirPorRespostaHumana(
  client: SupabaseClient,
  args: { organizationId: string; conversationId: string; contactId: string | null; userId: string },
): Promise<boolean> {
  const { organizationId, conversationId, contactId, userId } = args;
  try {
    const { data: org } = await client.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
    if (lerPrazoDeDevolucaoMinutos((org as { settings?: unknown } | null)?.settings) === null) return false;

    const { data: conv } = await client
      .from("conversations")
      .select("assignee_kind, assigned_to_user_id, is_group")
      .eq("id", conversationId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const c = conv as { assignee_kind: string | null; assigned_to_user_id: string | null; is_group: boolean } | null;
    // Grupo é sempre de humano e a devolução o ignora; quem já tem humano não troca de dono.
    if (!c || c.is_group || c.assignee_kind === "user" || c.assigned_to_user_id !== null) return false;

    const { data: linhas, error } = await client.rpc("fn_conversation_assign", {
      p_organization_id: organizationId,
      p_conversation_id: conversationId,
      p_to_user_id: userId,
      p_reason: MOTIVO_RESPOSTA_HUMANA,
      p_enforce_expected: true, // só assume se continua sem responsável (corrida: quem chegou antes ganha)
    });
    if (error) {
      logger.warn("atendimento.assumir_por_resposta: conversa não atribuída", { organizationId, conversationId, erro: error.message });
      return false;
    }
    if (!Array.isArray(linhas) || linhas.length === 0) return false;

    const dono = resolveOwnerPatch({ owner_user_id: userId });
    if (contactId && dono.ok && dono.patch) {
      const { error: erroLead } = await client
        .from("crm_leads")
        .update({ ...dono.patch, assigned_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .is("owner_user_id", null)
        .is("owner_agent_id", null);
      if (erroLead) {
        logger.warn("atendimento.assumir_por_resposta: negócio não herdou o dono", { organizationId, conversationId, erro: erroLead.message });
      }
    }
    return true;
  } catch (erro) {
    logger.warn("atendimento.assumir_por_resposta: falha", {
      organizationId,
      conversationId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}
