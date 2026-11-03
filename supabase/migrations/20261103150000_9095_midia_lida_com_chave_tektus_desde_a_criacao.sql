-- manifest: 9095 — toda organização nasce com `visao_de_imagem` apontando para a OpenRouter da Tektus (chave da instalação), então foto, áudio e documento são lidos com ou sem IA própria; backfill das que ficariam sem credencial utilizável. Antes: org nova semeada em `anthropic` sem chave derrubava 100% da leitura de mídia (Salão Fabiana Lopes 03/11: 132 de 132 falharam, "org sem credencial LLM utilizável").
--
-- A derivação (workers/media-derive-worker.ts) tenta o binding do ponto `visao_de_imagem` ANTES do padrão da org;
-- com binding, a resolução não lança e a escada de transcrição segue (OpenRouter da instalação como último degrau).
-- `credential_id` nulo = chave da instalação; `fn_org_pode_usar_ia_da_instalacao` continua mandando (plano com IA própria veta).

create or replace function public.fn_seed_org_midia_tektus() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id, is_enabled)
  values (new.id, 'visao_de_imagem', 'openrouter', 'google/gemini-2.5-flash-lite', true)
  on conflict (organization_id, purpose) do nothing;
  return new;
end; $$;

revoke all on function public.fn_seed_org_midia_tektus() from public;

drop trigger if exists trg_seed_org_midia_tektus on public.organizations;
create trigger trg_seed_org_midia_tektus
  after insert on public.organizations
  for each row execute function public.fn_seed_org_midia_tektus();

-- Backfill: só quem não tem binding de visão e cujo provedor padrão não tem credencial ativa e validada.
insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id, is_enabled)
select o.id, 'visao_de_imagem', 'openrouter', 'google/gemini-2.5-flash-lite', true
  from public.organizations o
 where not exists (select 1 from public.ai_purpose_bindings b where b.organization_id = o.id and b.purpose = 'visao_de_imagem')
   and not exists (
     select 1 from public.ai_provider_credentials c
      where c.organization_id = o.id and c.provider = o.settings->'llm'->>'provider'
        and c.is_active and c.validated_at is not null)
on conflict (organization_id, purpose) do nothing;
