-- manifest: 9086 — decrypt_cpf_lote(uuid[]): o export de contatos decifra o CPF em blocos (uma RPC e uma linha de audit por organização a cada bloco) em vez de uma RPC por contato; mesma guarda de org e papel (manager+) da decrypt_cpf.
--
-- O GET /api/v1/contacts/export chamava decrypt_cpf contato a contato: até 10 mil
-- idas ao banco, em série, cada uma com o seu insert em api_audit_log. A função
-- abaixo faz o mesmo trabalho por bloco (teto de 1000 ids por chamada).
--
-- O que NÃO muda: a guarda. Toda organização dona de um contato do bloco passa
-- pelas MESMAS duas checagens da decrypt_cpf (fn_user_org_ids ou platform admin,
-- depois fn_role_at_least manager); uma que falhe derruba o bloco inteiro com
-- forbidden_org / forbidden_role, antes de qualquer audit ou decifração. O audit
-- continua sendo 'contact.cpf_decrypted', gravado ANTES do texto: uma linha por
-- organização do bloco, com os ids em metadata.contact_ids (resource_id nulo).
--
-- O que muda de propósito: cifra malformada (curta ou sem cara de pacote PGP)
-- devolve cpf nulo para AQUELE contato em vez de levantar. Cifra com cabeçalho
-- válido e corpo ruim ainda levanta e o bloco sai com a coluna vazia.
--
-- Audit e decifração só leem contatos das orgs aprovadas no loop (v_orgs): sem
-- isso, um CPF gravado ou uma org trocada entre a guarda e o return query
-- passaria sem checagem (READ COMMITTED vê snapshot novo a cada comando).
--
-- Reverter: drop function if exists public.decrypt_cpf_lote(uuid[]);

create or replace function public.decrypt_cpf_lote(p_contact_ids uuid[])
returns table (contact_id uuid, cpf text)
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  v_org uuid;
  v_orgs uuid[] := '{}';
begin
  if p_contact_ids is null or cardinality(p_contact_ids) = 0 then
    return;
  end if;
  if cardinality(p_contact_ids) > 1000 then
    raise exception 'lote_grande_demais';
  end if;

  -- Guardas por organização, as mesmas da decrypt_cpf e na mesma ordem.
  for v_org in
    select distinct c.organization_id
      from public.contacts c
     where c.id = any(p_contact_ids) and c.cpf_encrypted is not null
  loop
    if not exists (
      select 1 from public.fn_user_org_ids() o where o = v_org
    ) and not public.fn_is_platform_admin() then
      raise exception 'forbidden_org';
    end if;
    if not public.fn_role_at_least(v_org, 'manager') and not public.fn_is_platform_admin() then
      raise exception 'forbidden_role';
    end if;
    v_orgs := v_orgs || v_org;
  end loop;

  -- Audit antes do plaintext: uma linha por organização do bloco.
  insert into public.api_audit_log
    (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  select c.organization_id, auth.uid(), 'contact.cpf_decrypted', 'contact', null,
         jsonb_build_object(
           'purpose', current_setting('app.decrypt_purpose', true),
           'contact_ids', jsonb_agg(c.id),
           'total', count(*))
    from public.contacts c
   where c.id = any(p_contact_ids) and c.cpf_encrypted is not null
     and c.organization_id = any(v_orgs)
   group by c.organization_id;

  -- CASE avalia em ordem: get_byte só roda em bytea com o piso de 66 bytes.
  return query
    select c.id,
           case
             when octet_length(c.cpf_encrypted) < 66 then null
             when get_byte(c.cpf_encrypted, 0) < 128 then null
             else pgp_sym_decrypt(c.cpf_encrypted, private.fn_cpf_key())
           end
      from public.contacts c
     where c.id = any(p_contact_ids) and c.cpf_encrypted is not null
       and c.organization_id = any(v_orgs);
end$$;

revoke execute on function public.decrypt_cpf_lote(uuid[]) from public, anon;
grant  execute on function public.decrypt_cpf_lote(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
