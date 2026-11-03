import type pg from "pg";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { extrairObjetoJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import { vocabularioDeMotivos } from "@/lib/leads/motivo-da-perda";
import {
  decide,
  montaPrompt,
  saidaDoOrganizadorSchema,
  type Decisao,
  type EtapaDoFunil,
  type MensagemDaConversa,
} from "./decidir";
import { moverNegocioDeFunil } from "@/lib/leads/mover-de-funil";
import { atalhoDaLoja, avaliaSilencio, pedeTroca, semAutomaticas, type RegrasDaLoja } from "./regras-da-loja";

/**
 * Uma passada do Organizador sobre UM negócio: lê a conversa, pergunta ao modelo
 * em que etapa o card deveria estar (uma chamada, sem ferramentas, sem canal) e
 * aplica pelo MESMO `moveLeadHandler` do board, do lote e do agente, que já
 * cobra campos obrigatórios, motivo de perda e funil.
 *
 * `dryRun` registra a decisão em `organizador_passadas` e NÃO move: é como se
 * confere uma amostra antes de liberar o lote.
 */
export interface Logger {
  info: (msg: string, f?: Record<string, unknown>) => void;
  warn: (msg: string, f?: Record<string, unknown>) => void;
}

export interface ResultadoDaPassada {
  leadId: string;
  decisao: Decisao | { mover: false; porque: string };
  aplicado: boolean;
  justificativa?: string;
}

const MENSAGENS_LIDAS = 40;

export async function organizaLead(
  pool: pg.Pool,
  cfg: { llm: LlmEdgeConfig; crm: CrmEdgeConfig },
  input: {
    organizationId: string;
    leadId: string;
    dryRun: boolean;
    ultimaMsgEm: string | null;
    instrucoes?: string | null;
    regras?: RegrasDaLoja;
    /** Passada do prazo de silêncio: não chama o modelo, só confere se o prazo de perda venceu. */
    soSilencio?: boolean;
  },
  log: Logger,
): Promise<ResultadoDaPassada> {
  const { organizationId, leadId, dryRun, ultimaMsgEm } = input;
  const regras = input.regras ?? {};
  // Grava SEMPRE o mesmo `ultimaMsgEm` que o seletor viu: qualquer ramo (ilegível, erro do modelo, sem
  // conversa) deixa o lead quieto até chegar mensagem nova, em vez de repetir a chamada paga a cada tick.
  const grava = async (decisao: Record<string, unknown>) => {
    // A passada de silêncio NÃO consome a passada do modelo: não mexe em `ultima_msg_em` (lead novo entra
    // com NULL, que o seletor do modelo aceita) e só junta a marca ao que já havia.
    await pool.query(
      input.soSilencio
        ? `insert into organizador_passadas (lead_id, organization_id, ultima_msg_em, passou_em, decisao)
           values ($1, $2, null, now(), $4::jsonb)
           on conflict (lead_id) do update
             set passou_em = now(), decisao = organizador_passadas.decisao || excluded.decisao`
        : `insert into organizador_passadas (lead_id, organization_id, ultima_msg_em, passou_em, decisao)
           values ($1, $2, $3, now(), $4::jsonb)
           on conflict (lead_id) do update
             set ultima_msg_em = excluded.ultima_msg_em, passou_em = now(), decisao = excluded.decisao`,
      [leadId, organizationId, ultimaMsgEm, JSON.stringify({ ...decisao, dry_run: dryRun, ...(input.soSilencio ? { silencio_ultima: ultimaMsgEm } : {}) })],
    );
  };

  const { rows: leads } = await pool.query<{
    contact_id: string;
    pipeline_id: string;
    stage_id: string;
    settings: unknown;
  }>(
    `select l.contact_id, l.pipeline_id, l.stage_id, p.settings
       from crm_leads l join crm_pipelines p on p.id = l.pipeline_id
      where l.id = $1 and l.organization_id = $2 and l.status = 'open'`,
    [leadId, organizationId],
  );
  const lead = leads[0];
  if (!lead) return { leadId, decisao: { mover: false, porque: "lead_nao_aberto" }, aplicado: false };

  const { rows: historicoDesc } = await pool.query<MensagemDaConversa>(
    `select m.direction, m.body, m.sent_at::text as sent_at
       from messages m
      where m.organization_id = $1
        and m.conversation_id = (select c.id from conversations c
                                  where c.organization_id = $1 and c.contact_id = $2
                                  order by c.last_message_at desc nulls last limit 1)
        and m.direction in ('inbound', 'outbound')
      order by m.sent_at desc limit ${MENSAGENS_LIDAS}`,
    [organizationId, lead.contact_id],
  );
  const historicoBruto = historicoDesc.reverse();
  // Resposta automática do outro lado nunca é "o cliente respondeu": sai antes de o modelo ou as regras lerem.
  const historico = semAutomaticas(historicoBruto);
  if (historico.every((m) => (m.body ?? "").trim() === "")) {
    await grava({ mover: false, porque: "sem_conversa" });
    return { leadId, decisao: { mover: false, porque: "sem_conversa" }, aplicado: false };
  }

  const { rows: etapas } = await pool.query<EtapaDoFunil>(
    `select id, name, position, is_won, is_lost, is_archived from crm_stages where pipeline_id = $1 and organization_id = $2`,
    [lead.pipeline_id, organizationId],
  );
  const motivos = vocabularioDeMotivos(lead.settings);

  // Decisões que o código toma sem o modelo (regras da loja). O modelo errou nelas na amostra da Fiorotto.
  let decisao: Decisao | undefined;
  let justificativaFinal = "";
  const silencio = avaliaSilencio(regras, historicoBruto, new Date());
  if (silencio === "perder") {
    const perda = etapas.find((e) => e.is_lost && !e.is_archived);
    const motivo = regras.motivo_perda ?? "";
    if (perda && motivos.includes(motivo)) {
      justificativaFinal = `Sem resposta do cliente há ${regras.dias_para_perda} dias ou mais depois da última mensagem da loja.`;
      decisao = { mover: true, etapa: perda, lostReason: motivo, justificativa: justificativaFinal };
    } else {
      await grava({ mover: false, porque: "silencio_sem_etapa_ou_motivo_de_perda" });
      return { leadId, decisao: { mover: false, porque: "silencio_sem_etapa_ou_motivo_de_perda" }, aplicado: false };
    }
  } else if (input.soSilencio) {
    const porque = silencio === "nao_vencido" ? "silencio_nao_vencido" : `silencio_bloqueado_${silencio}`;
    await grava({ mover: false, porque });
    return { leadId, decisao: { mover: false, porque }, aplicado: false };
  } else if (regras.funil_posvenda && pedeTroca(historico)) {
    // A venda aconteceu e agora é troca: o MESMO card vai para o funil de pós-venda (decisão de 19/10).
    const { rows: destino } = await pool.query<{ id: string }>(
      `select id from crm_pipelines where organization_id = $1 and lower(name) = lower($2) and id <> $3 limit 1`,
      [organizationId, regras.funil_posvenda, lead.pipeline_id],
    );
    const alvo = destino[0];
    if (!alvo) {
      await grava({ mover: false, porque: "ja_esta_no_funil_de_posvenda_ou_inexistente" });
      return { leadId, decisao: { mover: false, porque: "ja_esta_no_funil_de_posvenda_ou_inexistente" }, aplicado: false };
    }
    let aplicadoTroca = false;
    let recusaTroca: string | undefined;
    if (!dryRun) {
      const r = await moverNegocioDeFunil(
        cfg.crm.supabase,
        { organization_id: organizationId, actor: { type: "webhook_source", id: "organizador" }, requestId: `organizador:${leadId}` },
        { id: leadId, pipeline_id: lead.pipeline_id, stage_id: lead.stage_id, status: "open", contact_id: lead.contact_id },
        { pipelineId: alvo.id, origemDaChamada: "organizador" },
      );
      aplicadoTroca = r.ok;
      if (!r.ok) recusaTroca = r.texto.slice(0, 200);
    }
    const porque = "troca_ou_devolucao_vai_para_o_funil_de_posvenda";
    await grava({ mover: true, para_funil: regras.funil_posvenda, justificativa: "Conversa de troca, devolução ou garantia de uma venda já feita.", aplicado: aplicadoTroca, recusa_do_funil: recusaTroca, porque_do_atalho: porque });
    return { leadId, decisao: { mover: false, porque }, aplicado: aplicadoTroca, justificativa: "troca/devolução: funil de pós-venda" };
  } else {
    let atalho = atalhoDaLoja(regras, etapas, lead.stage_id, historico);
    if (atalho.mover) {
      // As 40 mensagens lidas podem esconder uma resposta antiga (ou de outra conversa do contato): na dúvida o modelo decide.
      const { rows: jaFalou } = await pool.query(
        `select 1 from messages m join conversations c on c.id = m.conversation_id
          where c.organization_id = $1 and c.contact_id = $2 and m.direction = 'inbound' limit 1`,
        [organizationId, lead.contact_id],
      );
      if (jaFalou.length > 0) atalho = { mover: false };
    }
    if (atalho.mover) {
      justificativaFinal = atalho.justificativa;
      decisao = { mover: true, etapa: atalho.etapa, justificativa: atalho.justificativa };
    }
  }

  if (!decisao) {
  const { system, user } = montaPrompt({ etapas, atualId: lead.stage_id, historico, motivos, instrucoes: input.instrucoes });

  let chamada: Awaited<ReturnType<typeof runModelCall>>;
  try {
    chamada = await runModelCall(
      pool,
      cfg.llm,
      { tenantId: organizationId, purpose: "organizador", system, messages: [{ role: "user", content: user }] },
      { log: log as never },
    );
  } catch (err) {
    await grava({ mover: false, porque: "erro_do_modelo", erro: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
    throw err;
  }
  const bruto = extrairObjetoJsonDoTexto(chamada.result.text);
  const saida = saidaDoOrganizadorSchema.safeParse(bruto);
  if (!saida.success) {
    // Saída ilegível não vira movimento: registra e segue; a próxima passada reler.
    await grava({ mover: false, porque: "saida_ilegivel" });
    return { leadId, decisao: { mover: false, porque: "saida_ilegivel" }, aplicado: false };
  }

  decisao = decide(saida.data, etapas, lead.stage_id, motivos, historico);
  justificativaFinal = saida.data.justificativa;
  }
  let aplicado = false;
  let recusa: string | undefined;
  if (decisao.mover && !dryRun) {
    // A chamada ao modelo leva segundos: se um humano ou o agente moveu o card nesse meio tempo, a
    // decisão foi tomada sobre a etapa velha e mover agora poderia recuar o card. A decisão dele vale.
    const { rows: agora } = await pool.query<{ stage_id: string }>(
      `select stage_id from crm_leads where id = $1 and organization_id = $2 and status = 'open'`,
      [leadId, organizationId],
    );
    if (agora[0]?.stage_id !== lead.stage_id) {
      await grava({ mover: false, porque: "card_mudou_durante_a_passada" });
      return { leadId, decisao: { mover: false, porque: "card_mudou_durante_a_passada" }, aplicado: false };
    }
    try {
      await moveLeadHandler(
        cfg.crm.supabase,
        {
          organization_id: organizationId,
          actor: { type: "webhook_source", id: "organizador" },
          requestId: `organizador:${leadId}`,
        },
        leadId,
        {
          to_stage_id: decisao.etapa.id,
          reason: `Movido pelo organizador: ${decisao.justificativa}`,
          ...(decisao.lostReason !== undefined ? { lost_reason: decisao.lostReason } : {}),
        },
      );
      aplicado = true;
    } catch (err) {
      // A régua do funil (campo obrigatório, reabertura…) venceu: vira rótulo, não incidente.
      recusa = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }
  await grava(
    {
      mover: decisao.mover,
      para: decisao.mover ? decisao.etapa.name : null,
      porque: decisao.mover ? undefined : decisao.porque,
      lost_reason: decisao.mover ? decisao.lostReason : undefined,
      justificativa: justificativaFinal,
      aplicado,
      recusa_do_funil: recusa,
    },
  );
  log.info("organizador: passada", { lead_id: leadId, mover: decisao.mover, aplicado, dry_run: dryRun });
  return { leadId, decisao, aplicado, justificativa: justificativaFinal };
}
