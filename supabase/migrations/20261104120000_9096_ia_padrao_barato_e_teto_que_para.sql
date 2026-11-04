-- manifest: 9096 — toda organização nasce com IA padrão na chave que a plataforma TEM (openrouter + anthropic/claude-haiku-5.5, com preço no catálogo) e com teto mensal que PARA a IA (US$ 10, bloquear, efetivo na criação). Backfill idempotente: provedor sem chave da plataforma e sem credencial própria ativa vai para o padrão; orçamento ausente ou `off` vira o teto padrão, só em org sem credencial própria ativa, efetivo em 7 dias. Escolha explícita (credencial própria, assinatura, modo avisar/bloquear já gravado, inclusive avisar com limite 0) não é tocada. Incidente 04/11: org semeada em anthropic sem ANTHROPIC_API_KEY caía no Sonnet via OpenRouter e 11 previews zeraram o saldo da plataforma.
--
-- Por que NÃO typesafe/jev-router: está em ai_models sem preço (input/output nulos) e as 2.411 chamadas
-- medidas gravaram cost_cents nulo; com ele de padrão o teto mensal nunca enxergaria gasto.
-- Teto US$ 10: maior mês medido de uma org foi US$ 4,27 (Delicatto, out/2026); 2,3x de folga.

create or replace function public.fn_seed_org_llm_defaults() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb), '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object('provider', 'openrouter', 'default_model', 'anthropic/claude-haiku-5.5'),
      true);
  end if;
  return new;
end; $$;

create or replace function public.fn_seed_org_teto_de_ia() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ai_budgets (organization_id, monthly_limit_cents, enforcement_mode, enforcement_effective_at, alarm_threshold_pct)
  values (new.id, 1000, 'bloquear', now(), 80)
  on conflict (organization_id) do nothing;
  return new;
end; $$;

revoke execute on function public.fn_seed_org_teto_de_ia() from public, anon, authenticated;

drop trigger if exists trg_seed_org_teto_de_ia on public.organizations;
create trigger trg_seed_org_teto_de_ia
  after insert on public.organizations
  for each row execute function public.fn_seed_org_teto_de_ia();

-- Backfill (1): provedor padrão sem chave da plataforma (só OPENROUTER existe) e sem credencial ativa da org.
update public.organizations o
   set settings = jsonb_set(o.settings, '{llm}',
         coalesce(o.settings->'llm', '{}'::jsonb)
           || jsonb_build_object('provider', 'openrouter', 'default_model', 'anthropic/claude-haiku-5.5'), true)
 where coalesce(o.settings->'llm'->>'provider', '') <> 'openrouter'
   and not exists (
     select 1 from public.ai_provider_credentials c
      where c.organization_id = o.id and c.provider = o.settings->'llm'->>'provider' and c.is_active);

-- Backfill (2): so org SEM credencial propria ativa (essa paga a propria IA) e sem linha, ou com linha `off`.
-- `avisar`/`bloquear` gravados (inclusive `avisar` com limite 0 = "sem limite") sao escolha de admin e ficam.
-- Efetivo em 7 dias: da tempo de ver o aviso antes de a IA parar.
insert into public.ai_budgets (organization_id, monthly_limit_cents, enforcement_mode, enforcement_effective_at, alarm_threshold_pct)
select o.id, 1000, 'bloquear', now() + interval '7 days', 80 from public.organizations o
 where not exists (select 1 from public.ai_provider_credentials c where c.organization_id = o.id and c.is_active)
on conflict (organization_id) do update
   set monthly_limit_cents = case when public.ai_budgets.monthly_limit_cents < 100 then 1000 else public.ai_budgets.monthly_limit_cents end,
       enforcement_mode = 'bloquear', enforcement_effective_at = now() + interval '7 days'
 where public.ai_budgets.enforcement_mode = 'off';
