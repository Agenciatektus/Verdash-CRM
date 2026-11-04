/**
 * ALERTA DO GASTO E DO SALDO DA CHAVE DE IA DA PLATAFORMA, no WhatsApp do dono da instalação.
 *
 * Os agentes dos clientes com plano de IA usam a OPENROUTER_API_KEY da plataforma: o saldo dela
 * nunca pode zerar sem aviso. Níveis: cada valor de AI_PLATAFORMA_ALERTA_USD_DIA, o corte de não
 * essenciais (AI_PLATAFORMA_CORTE_USD_DIA) e "saldo cobre menos de N dias do consumo médio".
 * Um envio por nível por dia (claim em `ia_plataforma_alertas`, migration 9097).
 *
 * Envio pelo "Aviso no WhatsApp" da org AI_PLATAFORMA_ALERTA_ORG_ID (o mesmo transporte do aviso de
 * caso e do vencimento da Meta). Sem org configurada, a rodada só mede. Nunca lança.
 */
import type pg from 'pg';

import type { EnviarWhatsApp } from '@/lib/plataformas-de-anuncio/meta/alerta/whatsapp';
import {
  SQL_GASTO_DA_PLATAFORMA_HOJE,
  SQL_MEDIA_DIARIA_7D,
  limitesDaPlataforma,
} from '@/lib/ai/plataforma/gasto-da-plataforma';

export interface Nivel {
  id: string;
  texto: string;
}

const usd = (cents: number) => `US$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** Decisão pura: quais níveis o dia já cruzou. */
export function niveisCruzados(e: {
  gastoHojeCents: number;
  alertasCents: number[];
  corteCents: number;
  saldoCents: number | null;
  mediaDiariaCents: number;
  diasDeSaldo: number;
}): Nivel[] {
  const niveis: Nivel[] = [];
  for (const a of e.alertasCents) {
    if (e.gastoHojeCents >= a) {
      niveis.push({ id: `gasto_${a}`, texto: `A chave de IA da plataforma já gastou ${usd(e.gastoHojeCents)} hoje (aviso em ${usd(a)}).` });
    }
  }
  if (e.gastoHojeCents >= e.corteCents) {
    niveis.push({
      id: `corte_${e.corteCents}`,
      texto: `A chave de IA da plataforma passou de ${usd(e.corteCents)} hoje: testes de agente e tarefas não essenciais estão pausados até amanhã. O atendimento aos clientes continua.`,
    });
  }
  if (e.saldoCents !== null && e.mediaDiariaCents > 0) {
    const dias = e.saldoCents / e.mediaDiariaCents;
    if (dias < e.diasDeSaldo) {
      niveis.push({
        id: 'saldo_dias',
        texto: `O saldo da OpenRouter está em ${usd(e.saldoCents)}, perto de ${dias.toFixed(1).replace('.', ',')} dia(s) do consumo médio. Recarregue antes que os agentes dos clientes parem.`,
      });
    }
  }
  return niveis;
}

/** Saldo restante da conta OpenRouter (GET /api/v1/credits). null = não deu para ler. */
export async function lerSaldoOpenRouterCents(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  if (!apiKey) return null;
  try {
    const r = await fetchFn('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { total_credits?: number; total_usage?: number } };
    const total = j.data?.total_credits;
    const usado = j.data?.total_usage;
    if (typeof total !== 'number' || typeof usado !== 'number') return null;
    return Math.round((total - usado) * 100);
  } catch {
    return null;
  }
}

export interface ResumoDoAlerta {
  gastoHojeCents: number | null;
  saldoCents: number | null;
  niveis: string[];
  enviados: number;
  falhas: string[];
}

export async function rodadaDoAlertaDaPlataforma(deps: {
  db: pg.Pool;
  enviar: EnviarWhatsApp;
  orgDoAviso: string;
  apiKey: string;
  agora: Date;
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<ResumoDoAlerta> {
  const resumo: ResumoDoAlerta = { gastoHojeCents: null, saldoCents: null, niveis: [], enviados: 0, falhas: [] };
  try {
    const lim = limitesDaPlataforma(deps.env);
    const [hoje, media, saldo] = await Promise.all([
      deps.db.query<{ cents: number }>(SQL_GASTO_DA_PLATAFORMA_HOJE),
      deps.db.query<{ cents: number }>(SQL_MEDIA_DIARIA_7D),
      lerSaldoOpenRouterCents(deps.apiKey, deps.fetchFn),
    ]);
    resumo.gastoHojeCents = Number(hoje.rows[0]?.cents ?? 0);
    resumo.saldoCents = saldo;
    const niveis = niveisCruzados({
      gastoHojeCents: resumo.gastoHojeCents,
      alertasCents: lim.alertasCents,
      corteCents: lim.corteCents,
      saldoCents: saldo,
      mediaDiariaCents: Number(media.rows[0]?.cents ?? 0),
      diasDeSaldo: lim.diasDeSaldo,
    });
    resumo.niveis = niveis.map((n) => n.id);
    if (!deps.orgDoAviso) return resumo;
    const dia = deps.agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    for (const n of niveis) {
      // Claim antes do envio: dois crons simultâneos não mandam o mesmo nível duas vezes.
      const claim = await deps.db.query(
        `insert into public.ia_plataforma_alertas (dia, nivel) values ($1, $2) on conflict do nothing returning nivel`,
        [dia, n.id],
      );
      if (claim.rowCount === 0) continue;
      const desfecho = await deps.enviar(deps.orgDoAviso, `[Alerta de IA da plataforma] ${n.texto}`);
      if (desfecho === 'enviado') resumo.enviados += 1;
      else resumo.falhas.push(`${n.id}:${desfecho}`);
    }
  } catch (err) {
    resumo.falhas.push(`rodada:${err instanceof Error ? err.message : String(err)}`);
  }
  return resumo;
}
