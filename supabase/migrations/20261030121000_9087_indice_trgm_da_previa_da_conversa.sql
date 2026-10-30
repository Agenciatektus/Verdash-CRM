-- manifest: 9087 — índice GIN trigram em conversations.last_message_preview: a busca do Inbox faz ilike '%termo%' nessa coluna e era Seq Scan na tabela de conversas.
--
-- A busca do Inbox (app/api/v1/conversations/_handler.ts) casa o termo em
-- contacts.display_name, contacts.name, contacts.phone_number (os três já têm
-- trigram: idx_contacts_org_name_trgm e a 9047) e em
-- conversations.last_message_preview, que não tinha.
--
-- Sem CONCURRENTLY aqui, no padrão da 9047: migration roda em transação. Em
-- PRODUÇÃO crie à mão ANTES do deploy, fora de transação; o `if not exists`
-- torna a linha abaixo no-op lá:
--
--   set lock_timeout = '3s';
--   create index concurrently if not exists idx_conversations_last_message_preview_trgm
--     on public.conversations using gin (last_message_preview public.gin_trgm_ops);
--
-- Conferir: `select indisvalid from pg_index where indexrelid =
-- 'public.idx_conversations_last_message_preview_trgm'::regclass;` = t. Se f,
-- `drop index concurrently` e repetir.
--
-- Reverter: drop index if exists public.idx_conversations_last_message_preview_trgm;

create index if not exists idx_conversations_last_message_preview_trgm
  on public.conversations using gin (last_message_preview public.gin_trgm_ops);
