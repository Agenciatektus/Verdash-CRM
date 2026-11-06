-- 9101 — provider 'mercadophone' (PDV da loja) em tenant_integrations.
--
-- A conexão do MercadoPhone não tem OAuth: o admin cola dois tokens (o da API,
-- em oauth_access_token_encrypted, e o de segurança do webhook, em
-- webhook_secret_encrypted). Só falta o CHECK aceitar o provider.
--
-- LISTA LITERAL, não aditiva (padrão da 9023): os gates leem o SQL
-- estaticamente. Alargamento puro: toda linha que passava passa, sem backfill.
--
-- Reverter: refazer o CHECK sem 'mercadophone' (só com zero linhas dele).

set local lock_timeout = '3s';

alter table public.tenant_integrations
  drop constraint if exists tenant_integrations_provider_check;
alter table public.tenant_integrations
  add constraint tenant_integrations_provider_check check (provider in (
    'nuvemshop', 'vtex', 'shopify', 'mercadophone'
  ));
