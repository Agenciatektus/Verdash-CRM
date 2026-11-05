-- manifest: 9098 — teto mensal de IA da PLATAFORMA padrão por plano (decisão 05/11/2026): plano sem IA (nem `inclui_ia` nem `ia_propria`) trava em US$ 6 com aviso em US$ 3; plano com IA (`inclui_ia`) trava em US$ 10 com aviso em US$ 6; plano de IA própria fica sem teto porque a chave da instalação já não o serve (9075). `cobranca_planos` ganha `aviso_ia_usd_cents` (nulo = aviso em 80% do teto, o de sempre). Backfill só em plano com teto ainda nulo: teto gravado pelo admin não é tocado. Repete o backfill de provider da 9096 com o predicado certo (org sem NENHUMA credencial ativa, de qualquer provedor). Aditiva e idempotente; os backfills não entram no baseline.
--
-- O teto é do PLANO, não da org: fn_limite_do_plano(org, 'ia_usd_cents') lê o plano vigente da assinatura, então org
-- nova e troca de plano herdam o teto sem semente por org. Vale só para a chave da instalação (decidirTetoDoPlano).
-- Reverter: alter table public.cobranca_planos drop column if exists aviso_ia_usd_cents; (o teto backfillado volta a nulo à mão)

set lock_timeout = '3s';

alter table public.cobranca_planos
  add column if not exists aviso_ia_usd_cents integer check (aviso_ia_usd_cents > 0);

comment on column public.cobranca_planos.aviso_ia_usd_cents is
  'Gasto de IA do mês (centavos de dólar, régua de fn_gasto_de_ia_do_mes) em que a empresa recebe o aviso do teto do plano. Nulo ou >= teto_ia_usd_cents = aviso em 80% do teto (lib/cobranca/rodada.ts). Migration 9098.';

-- Backfill (1): padrão por tipo de plano, só onde ninguém gravou teto.
update public.cobranca_planos
   set teto_ia_usd_cents  = case when inclui_ia then 1000 else 600 end,
       aviso_ia_usd_cents = case when inclui_ia then 600 else 300 end
 where teto_ia_usd_cents is null
   and not ia_propria;

-- Backfill (2): o (1) da 9096 olhava só a credencial do provedor gravado em settings; org com credencial própria
-- ativa de OUTRO provedor (dr-paulo, salao-fabiana-lopes) caía no padrão. Aqui: qualquer credencial ativa poupa a org.
-- Onde a 9096 já rodou isto não desfaz nada; só impede que a correção dependa de alguém lembrar do predicado.
update public.organizations o
   set settings = jsonb_set(o.settings, '{llm}',
         coalesce(o.settings->'llm', '{}'::jsonb)
           || jsonb_build_object('provider', 'openrouter', 'default_model', 'anthropic/claude-haiku-5.5'), true)
 where coalesce(o.settings->'llm'->>'provider', '') <> 'openrouter'
   and not exists (
     select 1 from public.ai_provider_credentials c
      where c.organization_id = o.id and c.is_active);

notify pgrst, 'reload schema';
