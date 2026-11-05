-- manifest: 9098 — teto mensal de IA da PLATAFORMA por plano (decisão 05/11/2026), que soma SÓ o custo da chave da instalação. `llm_calls` ganha `chave_da_instalacao` (nulo = linha antiga ou escritor que não sabe = conta) e nasce `fn_gasto_de_ia_da_instalacao_do_mes(p_org)`, lida pelo teto do plano (orcamento.ts, rodada.ts); assinatura GPT e chave própria da org ficam fora da cota. `cobranca_planos` ganha `aviso_ia_usd_cents` (nulo = 80% do teto). Backfill UMA vez: plano sem IA com teto nulo vira trava US$ 6 / aviso US$ 3; plano `inclui_ia` vira trava US$ 10 / aviso US$ 6, SOBRESCREVENDO o US$ 15 que estava em produção (decisão explícita do Peterson); plano `ia_propria` fica sem teto (9075). Aditiva e idempotente; os backfills não entram no baseline.
--
-- O teto é do PLANO, não da org: fn_limite_do_plano(org, 'ia_usd_cents') lê o plano vigente da assinatura, então org
-- nova e troca de plano herdam o teto sem semente por org. Só bloqueia a chave da instalação (decidirTetoDoPlano).
-- Reverter: alter table public.cobranca_planos drop column if exists aviso_ia_usd_cents;
--           drop function if exists public.fn_gasto_de_ia_da_instalacao_do_mes(uuid);
--           alter table public.llm_calls drop column if exists chave_da_instalacao;

set lock_timeout = '3s';

alter table public.llm_calls
  add column if not exists chave_da_instalacao boolean;

comment on column public.llm_calls.chave_da_instalacao is
  'true = a chamada saiu na chave de IA da instalação (a plataforma pagou); false = credencial ou assinatura da org. Nulo = linha anterior à 9098 ou escritor que não informa, e CONTA no teto do plano (fn_gasto_de_ia_da_instalacao_do_mes). Migration 9098.';

-- A régua do teto do PLANO. A do orçamento da org continua fn_gasto_de_ia_do_mes (todo gasto).
create or replace function public.fn_gasto_de_ia_da_instalacao_do_mes(p_org uuid)
returns numeric
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(sum(cost_cents), 0)::numeric
    from public.llm_calls
   where organization_id = p_org
     and created_at >= date_trunc('month', now())
     and chave_da_instalacao is not false;
$$;

comment on function public.fn_gasto_de_ia_da_instalacao_do_mes(uuid) is
  'Gasto de IA do mês da organização pago pela chave da INSTALAÇÃO, em centavos de dólar: a régua do teto do plano (SQL_TETO_DO_PLANO em lib/agent-engine/edge/llm/orcamento.ts e o aviso em lib/cobranca/rodada.ts). Linha com chave_da_instalacao nula conta (antiga ou escritor que não informa). security invoker pelo mesmo motivo de fn_gasto_de_ia_do_mes. Migration 9098.';

revoke execute on function public.fn_gasto_de_ia_da_instalacao_do_mes(uuid)
  from public, anon, authenticated;
grant  execute on function public.fn_gasto_de_ia_da_instalacao_do_mes(uuid)
  to service_role;

alter table public.cobranca_planos
  add column if not exists aviso_ia_usd_cents integer check (aviso_ia_usd_cents > 0);

comment on column public.cobranca_planos.aviso_ia_usd_cents is
  'Gasto de IA do mês (centavos de dólar, régua de fn_gasto_de_ia_da_instalacao_do_mes) em que a empresa recebe o aviso do teto do plano. Nulo ou >= teto_ia_usd_cents = aviso em 80% do teto (lib/cobranca/rodada.ts). Migration 9098.';

-- Backfill (1), plano sem IA: só onde o teto ainda é nulo (teto gravado pelo admin não é tocado).
update public.cobranca_planos
   set teto_ia_usd_cents = 600, aviso_ia_usd_cents = 300
 where teto_ia_usd_cents is null
   and not inclui_ia
   and not ia_propria;

-- Backfill (2), plano com IA: override EXPLÍCITO. Em 05/11/2026 os dois planos `inclui_ia` de produção estavam com
-- teto 1500 (US$ 15); o Peterson decidiu US$ 10 com aviso em US$ 6. Só a primeira aplicação muda algo: depois que
-- o aviso está gravado, um teto ajustado pelo admin não volta para 1000.
update public.cobranca_planos
   set teto_ia_usd_cents = 1000, aviso_ia_usd_cents = 600
 where inclui_ia
   and aviso_ia_usd_cents is null;

-- Backfill (3): repete o backfill de provider da 9096 com o predicado certo (org sem NENHUMA credencial ativa, de
-- qualquer provedor). NÃO desfaz a 9096: só age em org que, entre a 9096 e a 9098, mudou para provider diferente
-- de openrouter sem ter credencial nenhuma; org com credencial ativa (dr-paulo, salao-fabiana-lopes) não é tocada.
update public.organizations o
   set settings = jsonb_set(o.settings, '{llm}',
         coalesce(o.settings->'llm', '{}'::jsonb)
           || jsonb_build_object('provider', 'openrouter', 'default_model', 'anthropic/claude-haiku-5.5'), true)
 where coalesce(o.settings->'llm'->>'provider', '') <> 'openrouter'
   and not exists (
     select 1 from public.ai_provider_credentials c
      where c.organization_id = o.id and c.is_active);

notify pgrst, 'reload schema';
