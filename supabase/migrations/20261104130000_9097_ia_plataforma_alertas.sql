-- manifest: 9097 — `ia_plataforma_alertas`: claim de um envio por nível por dia do alerta de gasto e saldo da chave de IA da plataforma (cron `ia-plataforma-alerta`, lib/ai/plataforma/alerta-de-saldo.ts). Da instalação, sem organization_id: RLS ligada sem policy, só service_role. Aditiva e idempotente.

create table if not exists public.ia_plataforma_alertas (
  dia date not null,
  nivel text not null,
  criado_em timestamptz not null default now(),
  primary key (dia, nivel)
);

alter table public.ia_plataforma_alertas enable row level security;
revoke all on table public.ia_plataforma_alertas from public, anon, authenticated;
