/**
 * GASTO DIÁRIO DA CHAVE DA PLATAFORMA (OPENROUTER_API_KEY) — soma de TODAS as organizações.
 *
 * Incidente 04/11/2026: 11 previews zeraram o saldo da chave que atende toda org com plano de IA.
 * O teto mensal protege cada cliente; este número protege a chave de todos.
 *
 * ⚠️ A ORDEM DO CORTE é a regra que não se negocia: passado o nível de corte, só caem os purposes
 * de NAO_ESSENCIAIS. Turno de resposta ao cliente (agent_turn e auxiliares do turno) NUNCA cai aqui;
 * quem protege o cliente é o teto mensal da org, e o limite duro no painel do OpenRouter fica acima
 * deste corte para o alerta chegar antes.
 *
 * shortcut: `llm_calls` não grava a origem da chave; "chave da plataforma" = provider openrouter em
 * org sem credencial openrouter ativa. Upgrade = gravar a origem da chave na linha.
 */
import type pg from 'pg';

/** Purposes que podem cair quando a chave da plataforma passa do corte do dia. */
export const NAO_ESSENCIAIS: readonly string[] = ['agent_preview', 'flywheel_judge', 'flywheel_distiller'];

export const SQL_GASTO_DA_PLATAFORMA_HOJE = `
  select coalesce(sum(l.cost_cents), 0)::float8 as cents
    from public.llm_calls l
   where l.provider = 'openrouter'
     and l.created_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
     and not exists (select 1 from public.ai_provider_credentials c
                      where c.organization_id = l.organization_id and c.provider = 'openrouter' and c.is_active)`;

/** Média diária dos 7 dias fechados anteriores, mesma régua da chave. */
export const SQL_MEDIA_DIARIA_7D = `
  select coalesce(sum(l.cost_cents), 0)::float8 / 7 as cents
    from public.llm_calls l
   where l.provider = 'openrouter'
     and l.created_at >= now() - interval '7 days'
     and not exists (select 1 from public.ai_provider_credentials c
                      where c.organization_id = l.organization_id and c.provider = 'openrouter' and c.is_active)`;

/** "0,50" / "0.5" / "" → centavos de dólar. Vazio ou inválido devolve o padrão. Nunca lança. */
export function usdParaCents(cru: string | undefined, padraoCents: number): number {
  const n = Number.parseFloat((cru ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : padraoCents;
}

export interface LimitesDaPlataforma {
  /** Níveis de alerta em centavos/dia, crescentes. Padrão 0,50 e 1,00 USD. */
  alertasCents: number[];
  /** Acima disto, NAO_ESSENCIAIS caem. Padrão 1,00 USD. */
  corteCents: number;
  /** Alerta quando o saldo cobre menos que estes dias de consumo médio. Padrão 3. */
  diasDeSaldo: number;
}

export function limitesDaPlataforma(env: Record<string, string | undefined> = process.env): LimitesDaPlataforma {
  const alertasCents = (env.AI_PLATAFORMA_ALERTA_USD_DIA ?? '').split(/[;|]/).map((v) => usdParaCents(v, 0)).filter((c) => c > 0);
  const dias = Number.parseFloat((env.AI_PLATAFORMA_ALERTA_DIAS_DE_SALDO ?? '').trim());
  return {
    alertasCents: (alertasCents.length ? alertasCents : [50, 100]).sort((a, b) => a - b),
    corteCents: usdParaCents(env.AI_PLATAFORMA_CORTE_USD_DIA, 100),
    diasDeSaldo: Number.isFinite(dias) && dias > 0 ? dias : 3,
  };
}

/** Decisão pura: este purpose, pela chave da plataforma, cai hoje? */
export function cortaNaoEssencial(e: {
  purpose: string;
  chaveDaPlataforma: boolean;
  gastoHojeCents: number;
  corteCents: number;
}): boolean {
  return e.chaveDaPlataforma && NAO_ESSENCIAIS.includes(e.purpose) && e.gastoHojeCents >= e.corteCents;
}

const MEMO_MS = 60_000;
let memo: { em: number; cents: number } | null = null;

/** Gasto de hoje com memo de 60 s (o gate roda por chamada). Leitura que falha devolve null. */
export async function gastoDaPlataformaHojeCents(db: pg.Pool, agora = Date.now()): Promise<number | null> {
  if (memo && agora - memo.em < MEMO_MS) return memo.cents;
  try {
    const { rows } = await db.query<{ cents: number }>(SQL_GASTO_DA_PLATAFORMA_HOJE);
    memo = { em: agora, cents: Number(rows[0]?.cents ?? 0) };
    return memo.cents;
  } catch {
    return null;
  }
}

/** Só para teste. */
export function limparMemoDoGastoDaPlataforma(): void {
  memo = null;
}

/**
 * O preview e as tarefas não essenciais passam? Leitura que falha SEGUE (o corte é de conforto,
 * o teto mensal da org continua valendo); errar duro aqui pararia preview por soluço de banco.
 */
export async function naoEssencialPodeSair(db: pg.Pool, purpose: string, chaveDaPlataforma: boolean): Promise<boolean> {
  if (!chaveDaPlataforma || !NAO_ESSENCIAIS.includes(purpose)) return true;
  const gasto = await gastoDaPlataformaHojeCents(db);
  if (gasto === null) return true;
  return !cortaNaoEssencial({ purpose, chaveDaPlataforma, gastoHojeCents: gasto, corteCents: limitesDaPlataforma().corteCents });
}
