/**
 * GATILHO POR FRASE: lê a mensagem que a loja ACABOU DE ENVIAR (`message.sent`) e, se ela
 * contém uma frase cadastrada numa etapa do funil (`crm_stages.gatilho_frases`), leva o
 * negócio aberto do contato para essa etapa. A regra do casamento mora em `gatilho-por-frase.ts`.
 *
 * ⚠️ A trava contra "o cliente escreveu a frase" é o PRÓPRIO EVENTO: `message.sent` só nasce
 * de mensagem de saída (`fn_emit_message_event`: direction ≠ inbound). Fala do cliente vira
 * `message.received` e este handler nunca a vê; ainda assim conferimos `direction` na linha
 * lida, porque o payload do evento não é a fonte da verdade.
 *
 * O movimento passa pelo `moveLeadHandler`, o mesmo do board, do agente e do Organizador:
 * campo obrigatório, motivo de ganho e funil continuam valendo, e `lead.stage_changed`
 * dispara campanha, follow-up, aviso e conversão como se um humano tivesse movido. Recusa
 * de regra de negócio (422) vira `skipped`, não `error`: o evento não deve girar em retry.
 */
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { etapaQueCasa, type EtapaComFrases } from "./gatilho-por-frase";

const CONSUMER_KEY = "leads.gatilho-por-frase";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

const falhou = (detail: string): HandlerResult => ({ consumer_key: CONSUMER_KEY, status: "error", detail });

type EtapaLida = EtapaComFrases & { pipeline_id: string };

async function handle(row: EventRow): Promise<HandlerResult> {
  const messageId = typeof row.payload?.message_id === "string" ? row.payload.message_id : null;
  const contactId = typeof row.payload?.contact_id === "string" ? row.payload.contact_id : null;
  if (!messageId || !contactId) return resultado("skipped", "sem_mensagem_ou_contato");

  const admin = createAdminClient();
  const org = row.organization_id;

  // ⚠️ Organização junto do id em toda leitura: o client é service-role e ignora RLS.
  const { data: etapasLidas, error: erroEtapas } = await admin
    .from("crm_stages")
    .select("id, pipeline_id, position, is_lost, is_archived, gatilho_frases")
    .eq("organization_id", org)
    .eq("is_archived", false)
    .neq("gatilho_frases", "{}");
  if (erroEtapas) return falhou(`leitura das etapas falhou: ${erroEtapas.message}`);
  const comFrases = ((etapasLidas ?? []) as EtapaLida[]).filter((e) => (e.gatilho_frases ?? []).length > 0);
  if (comFrases.length === 0) return resultado("skipped", "org_sem_gatilho");

  const { data: mensagem, error: erroMensagem } = await admin
    .from("messages")
    .select("direction, body")
    .eq("id", messageId)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroMensagem) return falhou(`leitura da mensagem falhou: ${erroMensagem.message}`);
  const lida = mensagem as { direction: string; body: string | null } | null;
  if (!lida || lida.direction !== "outbound") return resultado("skipped", "nao_e_mensagem_da_loja");
  const corpo = (lida.body ?? "").trim();
  if (corpo === "") return resultado("skipped", "mensagem_sem_texto");

  const { data: negocios, error: erroNegocios } = await admin
    .from("crm_leads")
    .select("id, stage_id, pipeline_id")
    .eq("organization_id", org)
    .eq("contact_id", contactId)
    .eq("status", "open");
  if (erroNegocios) return falhou(`leitura dos negócios falhou: ${erroNegocios.message}`);
  const abertos = (negocios ?? []) as Array<{ id: string; stage_id: string; pipeline_id: string }>;
  if (abertos.length === 0) return resultado("skipped", "sem_negocio_aberto");

  const { data: atuais, error: erroAtuais } = await admin
    .from("crm_stages")
    .select("id, position")
    .eq("organization_id", org)
    .in("id", abertos.map((n) => n.stage_id));
  if (erroAtuais) return falhou(`leitura das etapas atuais falhou: ${erroAtuais.message}`);
  const posicaoAtual = new Map(((atuais ?? []) as Array<{ id: string; position: number }>).map((e) => [e.id, e.position]));

  const movidos: string[] = [];
  const recusados: string[] = [];
  for (const negocio of abertos) {
    // Uma etapa só vale para o negócio do funil dela: frase do funil A não move card do B.
    const acionada = etapaQueCasa(corpo, comFrases.filter((e) => e.pipeline_id === negocio.pipeline_id));
    if (!acionada) continue;
    const atual = posicaoAtual.get(negocio.stage_id);
    // Só avança: card já na etapa, ou além dela, fica onde está (frase repetida não recua).
    if (atual === undefined || acionada.etapa.position <= atual) continue;
    try {
      await moveLeadHandler(
        admin,
        {
          organization_id: org,
          actor: { type: "webhook_source", id: "gatilho-por-frase" },
          requestId: `gatilho-frase:${messageId}:${negocio.id}`,
        },
        negocio.id,
        { to_stage_id: acionada.etapa.id, reason: `Gatilho por frase: "${acionada.frase}"` },
      );
      movidos.push(negocio.id);
    } catch (err) {
      // A régua do funil (campo obrigatório, motivo de ganho…) venceu: é decisão de negócio, não falha.
      if (err instanceof ApiError && err.status < 500) {
        recusados.push(`${negocio.id}:${err.code}`);
        continue;
      }
      return falhou(`mover o negócio falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (movidos.length > 0) return resultado("ok", `movidos=${movidos.length}`);
  if (recusados.length > 0) return resultado("skipped", `recusado_pelo_funil ${recusados.join(",")}`.slice(0, 300));
  return resultado("skipped", "nenhuma_frase_casou");
}

export const gatilhoPorFraseHandler: EventHandler = {
  key: CONSUMER_KEY,
  // Move card e dispara efeitos para fora (campanha, aviso, conversão): org parada não roda.
  naOrgParada: "pula",
  events: ["message.sent"],
  handle,
};
