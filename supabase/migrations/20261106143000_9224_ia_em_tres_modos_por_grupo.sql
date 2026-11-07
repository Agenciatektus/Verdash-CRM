-- manifest: 9224 — IA em três modos por grupo (off, chamada, todas): substitui o liga/desliga ia_responde. `chamada` só responde a mensagem que cita ou menciona o número. ia_responde segue espelhando ia_modo <> 'off' para leitores antigos.

set lock_timeout = '3s';

alter table public.channel_session_groups
  add column if not exists ia_modo text not null default 'off';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.channel_session_groups'::regclass
      and conname = 'channel_session_groups_ia_modo_check'
  ) then
    alter table public.channel_session_groups
      add constraint channel_session_groups_ia_modo_check check (ia_modo in ('off', 'chamada', 'todas'));
  end if;
end $$;

-- Quem já tinha a IA ligada continua respondendo toda mensagem.
update public.channel_session_groups set ia_modo = 'todas' where ia_responde and ia_modo = 'off';

-- LID do próprio número (aprendido nas mensagens que ele envia em grupo): grava SÓ a chave `own_lid`,
-- atômico. Regravar o metadata inteiro desfaria um `disabled`/`ai_gate` gravado no meio (molde 0545).
create or replace function public.fn_gravar_own_lid(p_organization_id uuid, p_channel_session_id uuid, p_lid text)
returns void
language sql
security definer
set search_path = public
as $function$
  update public.channel_sessions
     set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{own_lid}', to_jsonb(p_lid), true)
   where organization_id = p_organization_id
     and id = p_channel_session_id
     and p_lid ~ '^[0-9]{5,20}$'
     and coalesce(metadata->>'own_lid', '') is distinct from p_lid;
$function$;

revoke execute on function public.fn_gravar_own_lid(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_gravar_own_lid(uuid, uuid, text) to service_role;


notify pgrst, 'reload schema';
