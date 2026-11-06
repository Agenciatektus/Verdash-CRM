-- manifest: 9230 — cobranca_pagamentos (historico de pagamentos relido no provedor; unico em provedor + pagamento_ref para o upsert idempotente da sincronizacao). RLS: platform admin le tudo, admin da org le o seu; escrita so service_role. Sem PII de cartao. Tabela nova, aditiva e idempotente. Apendice igual no baseline.sql.
--
-- 9230: PR 1 do plano de cobranca e afiliados (A2). `sincronizar` grava aqui o
-- que releu no provedor (nunca o corpo do webhook); o estorno do admin marca a
-- linha. Base do historico de pagamentos e, depois, das comissoes.

create table if not exists public.cobranca_pagamentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provedor text not null check (provedor in ('stripe', 'asaas')),
  pagamento_ref text not null check (length(pagamento_ref) between 1 and 255),
  cobranca_ref text check (cobranca_ref is null or length(cobranca_ref) between 1 and 255),
  valor_cents integer not null check (valor_cents >= 0),
  moeda text not null check (moeda ~ '^[a-z]{3}$'),
  status text not null default 'pago' check (status in ('pago', 'estornado_parcial', 'estornado', 'contestado')),
  valor_estornado_cents integer not null default 0 check (valor_estornado_cents >= 0),
  pago_em timestamptz not null,
  estornado_em timestamptz,
  plano_id uuid references public.cobranca_planos(id) on delete set null,
  url_do_recibo text check (url_do_recibo is null or url_do_recibo ~ '^https?://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cobranca_pagamentos_estorno_ate_o_valor check (valor_estornado_cents <= valor_cents),
  constraint cobranca_pagamentos_provedor_ref_key unique (provedor, pagamento_ref)
);

create index if not exists cobranca_pagamentos_org_pago_em_idx
  on public.cobranca_pagamentos (organization_id, pago_em desc);

comment on table public.cobranca_pagamentos is
  'Pagamentos das empresas, relidos no provedor por sincronizar (migration 9230). Unico em (provedor, pagamento_ref). Leitura: platform admin e admin da org; escrita so service_role. Sem dado de cartao.';

alter table public.cobranca_pagamentos enable row level security;
drop policy if exists tenant_isolation_cobranca_pagamentos_select on public.cobranca_pagamentos;
create policy tenant_isolation_cobranca_pagamentos_select on public.cobranca_pagamentos
  for select to authenticated
  using ((select public.fn_is_platform_admin()) or public.fn_role_at_least(organization_id, 'admin'));
revoke all on public.cobranca_pagamentos from anon, authenticated;
grant select on public.cobranca_pagamentos to authenticated;
grant select, insert, update, delete on public.cobranca_pagamentos to service_role;

drop trigger if exists trg_cobranca_pagamentos_touch on public.cobranca_pagamentos;
create trigger trg_cobranca_pagamentos_touch
  before update on public.cobranca_pagamentos
  for each row execute function public.fn_touch_updated_at();
