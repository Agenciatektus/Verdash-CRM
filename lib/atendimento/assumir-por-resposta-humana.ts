/**
 * Quem responde pelo CRM passa a ser o responsável pela conversa (e pelo negócio aberto sem dono).
 *
 * Só liga em organização com `settings.routing.handoff_return_after_minutes` definido: conversa
 * com `assignee_kind='user'` veta a IA antes do gate, e quem devolve é o cron `handoff-devolucao`,
 * que só roda com esse prazo. Sem ele, nada muda (o silêncio de `manual_reply_silence_minutes`
 * continua sendo o único freio, como antes).
 *
 * Reusa `fn_conversation_assign` (conversa) e `adotarLeadsDoContato` (negócio, service role: RLS de visibility_mode='own' casaria 0 linhas, como no claim); não há caminho paralelo.
 * Resposta pelo celular (`external_device`) não passa por aqui: não identifica a pessoa.
 * Nunca lança: falhar em assumir não pode derrubar o envio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerPrazoDeDevolucaoMinutos } from "@/lib/escalacao/devolucao-automatica";
import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { adotarLeadsDoContato } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";

export const MOTIVO_RESPOSTA_HUMANA = "resposta_humana_crm";

const STATUS_ABERTOS = new Set(["open", "pending", "ai_handling"]);

/** Zero leituras: settings e a foto da conversa vêm do handler, que já os leu. */
export async function assumirPorRespostaHumana(
  client: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    contactId: string | null;
    userId: string;
    settings: unknown;
    conversa: { status: string | null; assignee_kind: string | null; assigned_to_user_id: string | null; is_group: boolean };
  },
): Promise<boolean> {
  const { organizationId, conversationId, contactId, userId, settings, conversa: c } = args;
  try {
    if (lerPrazoDeDevolucaoMinutos(settings) === null) return false;
    // Grupo é sempre de humano e a devolução o ignora; quem já tem humano não troca de dono;
    // conversa encerrada não é reaberta por resposta.
    if (c.is_group || c.assignee_kind === "user" || c.assigned_to_user_id !== null) return false;
    if (!STATUS_ABERTOS.has(c.status ?? "")) return false;

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

    // Sem `substituir`: só o negócio aberto SEM dono herda.
    if (contactId && isServiceRoleConfigured()) {
      await adotarLeadsDoContato(createAdminClient(), organizationId, contactId, userId);
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
