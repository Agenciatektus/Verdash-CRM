-- manifest: 9091 — organizador_passadas: uma linha por lead com a ultima passada do Organizador (varredura que le a conversa e sugere/aplica a etapa do card, sem canal de envio): ate que mensagem ele viu e a decisao (aplicada ou, em dry_run, so registrada). So service_role.
--
-- 9091: o Organizador varre os leads abertos dos funis ligados em `organizations.settings.organizador`.
-- Esta tabela e o que impede reler a mesma conversa a cada passada (`ultima_msg_em`) e o que deixa um
-- humano conferir o que ele decidiu antes de liberar o lote (`decisao`, com `dry_run`).
-- Aditiva, vazia, sem leitura por usuario (RLS ligada sem policy): nada do que existe muda.
create table if not exists public.organizador_passadas (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ultima_msg_em timestamptz,
  passou_em timestamptz not null default now(),
  decisao jsonb not null default '{}'::jsonb
);
create index if not exists organizador_passadas_org_idx on public.organizador_passadas (organization_id, passou_em desc);
alter table public.organizador_passadas enable row level security;
revoke all on table public.organizador_passadas from public, anon, authenticated;
grant select, insert, update on table public.organizador_passadas to service_role;
