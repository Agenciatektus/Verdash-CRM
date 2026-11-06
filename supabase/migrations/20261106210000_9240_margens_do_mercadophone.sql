-- manifest: 9240 — order_margins (custo e lucro por item vendido no MercadoPhone; só manager+ lê, escrita só service_role) — a margem não pode ir em orders.payload, que o time inteiro e as ferramentas MCP leem.

create table if not exists public.order_margins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  venda_id text not null,
  item_seq int not null,
  produto text,
  categoria text,
  quantidade numeric,
  valor_total_cents bigint not null,
  valor_custo_cents bigint not null,
  lucro_cents bigint not null,
  origem text,
  vendedor text,
  data_venda timestamptz not null,
  status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_margins_item_key unique (organization_id, venda_id, item_seq)
);

create index if not exists order_margins_org_data_idx
  on public.order_margins (organization_id, data_venda);

alter table public.order_margins enable row level security;
drop policy if exists order_margins_select on public.order_margins;
create policy order_margins_select on public.order_margins
  for select to authenticated
  using (public.fn_role_at_least(organization_id, 'manager'));
revoke all on public.order_margins from anon, authenticated;
grant select on public.order_margins to authenticated;
grant select, insert, update, delete on public.order_margins to service_role;
