-- manifest: 9093 — message.sent sai da lista de registro (fn_event_log_e_registro): ganhou consumidor (gatilho por frase, 9092); sem isto a linha nasceria `done` e o handler nunca rodaria.
--
-- 9093: a 0239 colocou `message.sent` na lista de REGISTRO (tipo que ninguem consome, linha nasce `done`).
-- O gatilho por frase (lib/leads/gatilho-por-frase.handler.ts) assina `message.sent`; com o tipo na lista, o
-- trigger fn_event_log_marca_registro trocaria `pending` por `done` e o drain nunca o selecionaria. Mesmo
-- caminho da 0417 com `message.failed`. Eventos antigos seguem `done` (nada e reprocessado); so os novos
-- nascem `pending`. A lista e identica a do baseline, menos este tipo.
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma ('lead.reopened' saiu na 0534: ele ganhou consumidor)
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.risk_backlog_seeded',
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' saiu na 0417 e 'message.sent' na 9093: ganharam consumidor)
    'message.outbound',
    'message.sending',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;
