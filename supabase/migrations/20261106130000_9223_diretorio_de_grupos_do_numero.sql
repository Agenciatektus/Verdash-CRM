-- manifest: 9223 — diretório (cache) dos grupos de cada número: a tela Canais > Grupos lia o FZAP inteiro a cada abertura (5,8 MB, até 30 s). Tabela própria, separada de channel_session_groups, que significa "grupo LIGADO". Guarda também archived/pinned espelhados do WhatsApp por evento.
-- Participantes nunca entram aqui: só contagens. Leitura só da própria organização; escrita só service_role.

set lock_timeout = '3s';

create table if not exists public.channel_session_group_directory (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  group_chat_id text not null check (group_chat_id like '%@g.us'),
  subject text,
  participant_count integer,
  admin_count integer not null default 0,
  papel text check (papel in ('dono', 'admin', 'membro')),
  is_announce boolean not null default false,
  tipo text not null default 'grupo' check (tipo in ('grupo', 'comunidade', 'grupo_da_comunidade')),
  archived boolean,
  pinned boolean,
  archived_changed_at timestamptz,
  refreshed_at timestamptz not null default now(),
  primary key (channel_session_id, group_chat_id)
);
create index if not exists idx_channel_session_group_directory_org
  on public.channel_session_group_directory (organization_id);
alter table public.channel_session_group_directory enable row level security;

drop policy if exists channel_session_group_directory_select on public.channel_session_group_directory;
create policy channel_session_group_directory_select on public.channel_session_group_directory
  for select using (organization_id in (select public.fn_user_org_ids()));
-- O default ACL de tabelas em `public` concede tudo a anon/authenticated (CLAUDE.md, 0258).
revoke insert, update, delete, truncate on public.channel_session_group_directory from anon, authenticated;
