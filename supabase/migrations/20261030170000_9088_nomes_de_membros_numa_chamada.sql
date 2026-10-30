-- manifest: 9088 — fn_nomes_de_membros(p_org, p_user_ids): nome e e-mail de membros da org numa chamada só, no lugar de um auth.admin.getUserById (HTTP ao GoTrue) por membro nas rotas de lista. Só service_role executa.
--
-- O nome de quem atende vivia só no GoTrue: cada rota de lista fazia uma ida HTTP por membro
-- (~60 ms cada). A 0202 resolveu o caso do Inbox desnormalizando o nome na conversa; aqui o
-- conserto geral é ler auth.users direto, uma vez por lista.
--
-- Guarda: só devolve quem tem (ou teve, revogado incluso, para o nome de autor histórico) vínculo
-- com p_org. Execução só para service_role: as rotas já resolvem a org de fonte confiável e chamam
-- pelo admin client. Se um dia a sessão do usuário chamar, a guarda de org abaixo já vale.
create or replace function public.fn_nomes_de_membros(p_org uuid, p_user_ids uuid[])
returns table (user_id uuid, full_name text, email text, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and not public.fn_is_platform_admin()
     and not (p_org in (select public.fn_user_org_ids())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select u.id, (u.raw_user_meta_data ->> 'full_name')::text, u.email::text, u.last_sign_in_at
    from auth.users u
   where u.id = any(p_user_ids)
     and exists (
       select 1 from public.user_organizations uo
        where uo.user_id = u.id and uo.organization_id = p_org
     );
end;
$$;

revoke execute on function public.fn_nomes_de_membros(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.fn_nomes_de_membros(uuid, uuid[]) to service_role;
