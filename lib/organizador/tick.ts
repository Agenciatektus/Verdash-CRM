import type pg from "pg";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import { lerRegras } from "./regras-da-loja";
import { organizaLead, type Logger } from "./varredura";

/** Quem organizar e quando: seletores de leads e o laço do worker. A passada de UM lead mora em `varredura.ts`. */

/**
 * Quem precisa de passada: lead aberto de funil ligado, com conversa que teve
 * mensagem depois da última passada, e parada há `quietoMin` minutos (a conversa
 * assentou), dentro da janela `janelaDias`. O mais antigo primeiro, `limite` por vez.
 */
export async function leadsParaOrganizar(
  pool: pg.Pool,
  input: { organizationId: string; pipelineIds: string[]; janelaDias: number; quietoMin: number; limite: number },
): Promise<Array<{ id: string; ultima: string }>> {
  const { rows } = await pool.query<{ id: string; ultima: string }>(
    `select l.id, u.ultima::text as ultima
       from crm_leads l
       join lateral (select max(m.sent_at) as ultima
                       from messages m join conversations c on c.id = m.conversation_id
                      where c.organization_id = l.organization_id and c.contact_id = l.contact_id
                        and m.direction in ('inbound', 'outbound')) u on true
       left join organizador_passadas p on p.lead_id = l.id
      where l.organization_id = $1 and l.status = 'open' and l.pipeline_id = any($2::uuid[])
        and u.ultima is not null
        and u.ultima > now() - make_interval(days => $3)
        and u.ultima < now() - make_interval(mins => $4)
        and (p.ultima_msg_em is null or u.ultima > p.ultima_msg_em)
      order by u.ultima asc limit $5`,
    [input.organizationId, input.pipelineIds, input.janelaDias, input.quietoMin, input.limite],
  );
  return rows;
}

/**
 * Quem pode ter vencido o prazo de silêncio: lead aberto cuja última mensagem tem mais de `dias` dias
 * (dentro da janela) e que ainda não foi avaliado para essa última mensagem. Sem chamada ao modelo.
 */
export async function leadsEmSilencio(
  pool: pg.Pool,
  input: { organizationId: string; pipelineIds: string[]; janelaDias: number; dias: number; limite: number },
): Promise<Array<{ id: string; ultima: string }>> {
  const { rows } = await pool.query<{ id: string; ultima: string }>(
    `select l.id, u.ultima::text as ultima
       from crm_leads l
       join lateral (select max(m.sent_at) as ultima
                       from messages m join conversations c on c.id = m.conversation_id
                      where c.organization_id = l.organization_id and c.contact_id = l.contact_id
                        and m.direction in ('inbound', 'outbound')) u on true
       left join organizador_passadas p on p.lead_id = l.id
      where l.organization_id = $1 and l.status = 'open' and l.pipeline_id = any($2::uuid[])
        and u.ultima is not null
        and u.ultima > now() - make_interval(days => $3)
        and u.ultima < now() - make_interval(days => $4)
        and (p.lead_id is null or ((p.ultima_msg_em is null or p.ultima_msg_em <= u.ultima)
             and p.decisao->>'silencio_ultima' is distinct from u.ultima::text
             and not (p.decisao ? 'reservado_para_amostra')))
      order by u.ultima asc limit $5`,
    [input.organizationId, input.pipelineIds, input.janelaDias, input.dias, input.limite],
  );
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Um tick: cada org ligada em `settings.organizador` ({ligado, pipeline_ids, dry_run, janela_dias}). */
export async function tickDoOrganizador(
  pool: pg.Pool,
  cfg: { llm: LlmEdgeConfig; crm: CrmEdgeConfig },
  log: Logger,
  limitePorOrg = 15,
): Promise<void> {
  // Um worker por vez: no deploy dois processos se sobrepõem e cada um pagaria a chamada e
  // emitiria o evento de etapa. O lock é de sessão, por isso a conexão dedicada.
  const conexao = await pool.connect();
  try {
    const { rows: lock } = await conexao.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('organizador')) as ok");
    if (!lock[0]?.ok) return;
    try {
      const { rows: orgs } = await pool.query<{ id: string; organizador: Record<string, unknown> }>(
        `select id, settings->'organizador' as organizador from organizations
          where status = 'active' and settings->'organizador'->>'ligado' = 'true'`,
      );
      for (const org of orgs) {
        // Config ruim de uma org não pode parar as outras: um try por org.
        try {
          const pipelineIds = (Array.isArray(org.organizador.pipeline_ids) ? org.organizador.pipeline_ids : []).filter(
            (v): v is string => typeof v === "string" && UUID.test(v),
          );
          if (pipelineIds.length === 0) continue;
          const janela = Number(org.organizador.janela_dias);
          const leads = await leadsParaOrganizar(pool, {
            organizationId: org.id,
            pipelineIds,
            janelaDias: Number.isFinite(janela) && janela > 0 ? Math.min(janela, 60) : 7,
            quietoMin: 5,
            limite: limitePorOrg,
          });
          const regras = lerRegras(org.organizador.regras);
          const comum = {
            organizationId: org.id,
            dryRun: org.organizador.dry_run === true,
            instrucoes: typeof org.organizador.instrucoes === "string" ? org.organizador.instrucoes : null,
            regras,
          };
          // Prazo de silêncio primeiro (barato, sem modelo); depois as passadas com conversa nova.
          const silenciosos = regras.dias_para_perda
            ? await leadsEmSilencio(pool, {
                organizationId: org.id,
                pipelineIds,
                // Larga de propósito: o silêncio vale para quem calou há mais que o prazo, não só dentro da janela do modelo.
                janelaDias: 90,
                dias: regras.dias_para_perda,
                limite: limitePorOrg,
              })
            : [];
          const fila = [
            ...silenciosos.map((l) => ({ ...l, soSilencio: true })),
            ...leads.map((l) => ({ ...l, soSilencio: false })),
          ];
          for (const l of fila) {
            try {
              await organizaLead(pool, cfg, { ...comum, leadId: l.id, ultimaMsgEm: l.ultima, soSilencio: l.soSilencio }, log);
            } catch (err) {
              log.warn("organizador: passada falhou", { lead_id: l.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
            }
          }
        } catch (err) {
          log.warn("organizador: org falhou", { org_id: org.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
        }
      }
    } finally {
      await conexao.query("select pg_advisory_unlock(hashtext('organizador'))");
    }
  } finally {
    conexao.release();
  }
}

export async function runOrganizadorLoop(
  pool: pg.Pool,
  cfg: { llm: LlmEdgeConfig; crm: CrmEdgeConfig },
  opts: { intervalMs: number },
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await tickDoOrganizador(pool, cfg, log);
    } catch (err) {
      log.warn("organizador: tick falhou", { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, opts.intervalMs);
      signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
  }
}
