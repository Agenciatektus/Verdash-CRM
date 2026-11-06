-- manifest: 9250 — organização nova nasce com IA padrão BARATA e NÃO-Anthropic: `fn_seed_org_llm_defaults` semeia `openrouter` + `google/gemini-2.5-flash-lite` (US$ 0,10/0,40 por M, a mesma chave da plataforma que a visão e o sentimento já usam). Substitui o seed da 9096 (`anthropic/claude-haiku-5.5`). Backfill idempotente: org que ainda tem o seed antigo e NENHUMA credencial própria ativa vai para o novo padrão; escolha explícita (credencial própria, assinatura, modelo diferente do seed) não é tocada. Decisão do Peterson, 06/11/2026: nenhuma org usa Anthropic por padrão quando há opção mais barata que faz bem o trabalho.
--
-- O teto do PLANO (só chave da plataforma) já é derivado do plano vigente da assinatura (9098), então org nova herda
-- sem semente. O `ai_budgets` (US$ 10, bloquear) da 9096 é o teto de RESERVA da org e não muda aqui.
-- Agente criado sem modelo herda este padrão da org; a implantação publica cada agente com o modelo escolhido
-- para o cliente (assinatura GPT quando existe), então o padrão só vale como piso.
-- Reverter: recriar fn_seed_org_llm_defaults com o corpo da 9096 (openrouter + anthropic/claude-haiku-5.5).
--           O backfill não precisa de reversão: era a escolha do seed, não da org.

create or replace function public.fn_seed_org_llm_defaults() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb), '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object('provider', 'openrouter', 'default_model', 'google/gemini-2.5-flash-lite'),
      true);
  end if;
  return new;
end; $$;

-- Backfill: só quem ainda carrega o seed antigo da 9096 e usa a chave da plataforma (sem credencial própria ativa).
update public.organizations o
   set settings = jsonb_set(o.settings, '{llm}',
         coalesce(o.settings->'llm', '{}'::jsonb)
           || jsonb_build_object('provider', 'openrouter', 'default_model', 'google/gemini-2.5-flash-lite'),
         true)
 where o.settings->'llm'->>'provider' = 'openrouter'
   and o.settings->'llm'->>'default_model' = 'anthropic/claude-haiku-5.5'
   and not exists (
     select 1 from public.ai_provider_credentials c
      where c.organization_id = o.id and c.is_active);
