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

notify pgrst, 'reload schema';
