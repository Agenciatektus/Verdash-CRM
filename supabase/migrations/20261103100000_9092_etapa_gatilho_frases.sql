-- manifest: 9092 — crm_stages.gatilho_frases: ate 5 frases por etapa; mensagem enviada pela loja com a frase leva o negocio aberto do contato para a etapa (so avanca). Lida por lib/leads/gatilho-por-frase.handler.ts.
--
-- 9092: gatilho por frase, cadastrado na pagina de funil (como a Verdash). Aditiva: coluna com default vazio,
-- nenhuma etapa existente muda de comportamento ate alguem cadastrar frase.
alter table public.crm_stages
  add column if not exists gatilho_frases text[] not null default '{}';

alter table public.crm_stages drop constraint if exists crm_stages_gatilho_frases_max5;
alter table public.crm_stages
  add constraint crm_stages_gatilho_frases_max5 check (
    cardinality(gatilho_frases) <= 5
    and array_position(gatilho_frases, null::text) is null
    and octet_length(array_to_string(gatilho_frases, '')) <= 600
  );

comment on column public.crm_stages.gatilho_frases is
  'Ate 5 frases (9092). Mensagem ENVIADA pela loja que contem uma delas (sem acento nem caixa) leva o negocio aberto do contato a esta etapa; so avanca. Fala do cliente nunca aciona.';
