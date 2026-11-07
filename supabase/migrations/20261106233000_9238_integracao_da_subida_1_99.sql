-- manifest: 9238 — Tektus: a subida do upstream 1.99 sem um lado apagar o outro (e a 9231 da dev). Roda por último e deixa a versão INTEGRADA de fn_enfileirar_midia_vencida: o prazo de mídia de GRUPO da nossa 9222 + o rastro da nota que perdeu o anexo por retenção (media_expired_at/media_retention_days no passo 2c) da 9050 do upstream (#3756). Repete as duas colunas da 9050 (add column if not exists) para não depender da ordem. Idempotente.
--
-- 9238: integração da subida do upstream 1.99 (mesmo defeito de ordem da 9099/9100).
-- A 9050 do upstream (carimbo 30/10) roda DEPOIS do que já está em produção e a
-- nossa 9222 (06/11) redefine a mesma função: quem rodasse por último apagaria o
-- outro. Esta é a versão letra a letra da 9222 com o passo 2c da 9050.
-- A CHECK agent_inbox_items_kind_check: a 9033 do upstream (28/10) já é a união
-- (todos os kinds da nossa 9099 + 3 novos), mas numa instalação nova a 9099 (05/11)
-- roda depois dela e encolhe a lista. Recriada aqui, idêntica à 9033.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    'task_due',
    'task_overdue',
    'assinatura_desconectada',
    'recuperacao_da_queda',
    'cliente_sem_resposta_na_queda',
    'other'
  ));

alter table public.conversation_notes
  add column if not exists media_expired_at timestamptz,
  add column if not exists media_retention_days integer;

create or replace function public.fn_enfileirar_midia_vencida(p_limite integer default 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
declare
  v_lim integer := greatest(1, least(coalesce(p_limite, 500), 5000));
  v_vencidas integer := 0;
  v_orfas integer := 0;
  -- Órfãos do bucket PRÓPRIO da nota interna (0483). Contam em `v_orfas`:
  -- é a mesma categoria — arquivo sem ponteiro — e a chave de retorno não
  -- muda (o `toEqual` congelado de `poda-de-midia.test.ts` mede as três).
  v_orfas_nota integer := 0;
  -- Anexo de nota VIVO que já passou da retenção (#1887). Conta em
  -- `v_vencidas`: é a MESMA categoria — arquivo vencido por idade — e a chave
  -- congelada do retorno (0435) não muda de nome nem de número.
  v_vencidas_nota integer := 0;
  -- O que o expurgo apagou NESTA chamada (#1765). Começa em 0 para que a
  -- rodada sem nada a expurgar devolva 0 — e não null, que o cron somaria
  -- como se fosse apagado.
  v_expurgadas integer := 0;
  -- Janela do expurgo, em UM lugar só: é a constante que se muda amanhã.
  v_janela_deleted interval := interval '90 days';
begin
  -- 0. EXPURGO: a linha `deleted` da RETENÇÃO já cumpriu o papel (o arquivo
  --    saiu do bucket) e nada mais precisa dela — sem isto a fila cresce sem
  --    teto (#1739, item 2). Só `deleted`: `skipped` é «o objeto já não
  --    existe», `failed` é a prova de uma remoção que nunca passou das 3
  --    tentativas, e a issue manda não mexer em nenhuma das duas.
  --    E só a de retenção (`request_id is null`): a linha de pedido LGPD é o
  --    ÚNICO registro por objeto de que a mídia do titular saiu do bucket — o
  --    worker só troca o `status` e nada audita a remoção física. Ela sai
  --    sozinha se o pedido for apagado (FK `on delete set null`).
  --    O `GET DIAGNOSTICS` conta o que o DELETE apagou NESTA chamada (#1765):
  --    sem ele a rodada que só expurgou é indistinguível, na trilha, da rodada
  --    que não tinha o que fazer.
  delete from public.storage_redaction_queue
   where status = 'deleted'
     and request_id is null
     and coalesce(processed_at, enqueued_at) < now() - v_janela_deleted;
  get diagnostics v_expurgadas = row_count;

  -- 1. VENCIDAS: arquivo de mensagem mais velho que a retenção da organização —
  --    SÓ de organização com o interruptor LIGADO (`media_retention_enforced`,
  --    0557/#1534) e que NÃO está com pedido LGPD em andamento: um pedido de
  --    acesso/eliminação em curso (`lgpd_requests` em `received`/`processing`)
  --    não pode ter o objeto destruído no meio do atendimento — a suspensão é
  --    da ORGANIZAÇÃO INTEIRA, o lado conservador de um prazo legal. O índice
  --    `lgpd_requests_org_status_idx` (organization_id, status) cobre a
  --    anti-join. A mensagem fica (texto, status, horário); o arquivo sai, a
  --    `media_url` também (a rota não busca de novo do provedor), a transcrição
  --    some junto (`media_derived_text`) e a tela mostra o aviso via
  --    `metadata.media_status='expired'`. O piso de 30 dias é o mesmo do
  --    formulário, mesmo com valor menor gravado no banco.
  --    GRUPO (`conversations.is_group`) vence em `group_media_retention_days`
  --    (padrão 30, piso 7, nunca acima do prazo normal): grupo recebe muita mídia e o prazo da conversa
  --    normal (piso 30) é longo demais para ele. Conversa normal não muda.
  with alvo as (
    select m.id, m.organization_id, m.media_storage_path as caminho,
           case when c.is_group
                then least(greatest(o.group_media_retention_days, 7), greatest(coalesce(o.media_retention_days, 365), 30))
                else greatest(coalesce(o.media_retention_days, 365), 30)
           end as retencao_dias
      from public.messages m
      join public.organizations o on o.id = m.organization_id
      join public.conversations c on c.id = m.conversation_id
     where m.media_storage_path is not null
       and o.media_retention_enforced
       -- Corte barato antes do join: nada vence com menos de 7 dias (piso do grupo).
       and m.created_at < now() - interval '7 days'
       and m.created_at < now() - make_interval(days => case when c.is_group
                                                         then least(greatest(o.group_media_retention_days, 7), greatest(coalesce(o.media_retention_days, 365), 30))
                                                         else greatest(coalesce(o.media_retention_days, 365), 30) end)
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = m.organization_id
            and r.status in ('received', 'processing')
       )
     order by m.created_at
     limit v_lim
     for update of m skip locked
  ), fila as (
    -- O arquivo só vai para a fila quando nenhuma OUTRA mensagem o usa: a foto
    -- de catálogo tem caminho fixo por conversa e é reaproveitada a cada
    -- reenvio (`fotos-do-produto.ts`), então a mensagem de ontem pode apontar
    -- para o mesmo arquivo da vencida. A vencida perde o caminho do mesmo
    -- jeito; o arquivo sai quando a última referência vencer (aqui) ou no
    -- passo 2, como órfão.
    --
    -- O `do update` é o conserto do #1739: se aquele caminho já saiu da fila
    -- (`deleted`) ou o objeto já nem existia (`skipped`), um arquivo NOVO pode
    -- estar gravado ali agora — e o `do nothing` da 0432 engolia este pedido
    -- silenciosamente, deixando o arquivo novo fora da retenção PARA SEMPRE.
    -- O `where` é a outra metade do conserto: `pending`/`failed` em curso não
    -- são interrompidos (uma remoção em andamento não perde a tentativa).
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct a.organization_id, 'whatsapp-media', a.caminho
      from alvo a
     where not exists (
       select 1 from public.messages m2
        where m2.media_storage_path = a.caminho
          and m2.id not in (select id from alvo)
     )
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas as (
    update public.messages m
       set media_storage_path = null,
           media_url = null,
           media_derived_text = null,
           metadata = coalesce(m.metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'media_status', 'expired',
                  'media_expired_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'media_retention_days', alvo.retencao_dias
                ),
           updated_at = now()
      from alvo
     where m.id = alvo.id
    returning 1
  )
  select count(*) into v_vencidas from limpas;

  -- 2. ÓRFÃOS: arquivo que nada no banco aponta — o rastro de conversa apagada.
  --    Só as duas pastas que o CRM grava por mensagem e por contato:
  --    `org/<conversa>/…` e `org/avatars/…`. `org/templates/…` (cabeçalho de
  --    modelo) NUNCA entra: quem o usa guarda o link, não o caminho. Um dia de
  --    carência cobre o envio que sobe o arquivo antes de gravar a mensagem.
  with orfaos as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'whatsapp-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.organizations g where g.id::text = split_part(o.name, '/', 1))
       and (
         split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or split_part(o.name, '/', 2) = 'avatars'
         -- Miniatura da imagem (9033): `org/miniaturas/<conversa>/…`. Conta como
         -- referência o `media_thumb_path`, e não a pasta inteira ignorada:
         -- miniatura sem ponteiro (upload sem a linha gravada) é órfã como
         -- qualquer outra (P2-3 do @Cassio_SecRev na #75).
         or (split_part(o.name, '/', 2) = 'miniaturas'
             and split_part(o.name, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       )
       and not exists (select 1 from public.messages m where m.media_storage_path = o.name)
       and not exists (select 1 from public.messages m where m.media_thumb_path = o.name)
       and not exists (select 1 from public.contacts c where c.avatar_storage_path = o.name)
       -- Só linha EM CURSO segura o caminho (`pending`, ou `failed` que ainda
       -- é o registro de uma remoção não feita). Linha `deleted`/`skipped`
       -- NÃO bloqueia mais: é justamente o caso do avatar reaproveitado
       -- (#1739) — o objeto novo no caminho antigo tinha de chegar no conflito
       -- lá embaixo para ser reaberto, e este `not exists` o engolia antes.
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'whatsapp-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'whatsapp-media', caminho from orfaos
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas from fila;


  -- 2b. ÓRFÃOS DA NOTA INTERNA (migration 0483): o passo 2 varre SÓ o bucket
  --     `whatsapp-media` (filtro `bucket_id`), então um anexo de nota nunca
  --     entraria na conta — e a nota que o atendente apagou deixaria o arquivo
  --     para sempre no `internal-media`, custo que só cresce. Mesmo desenho do
  --     passo 2, com as duas pontas certas: bucket `internal-media` e
  --     `conversation_notes.media_storage_path` como a referência que segura o
  --     caminho. Um dia de carência cobre o upload que sobe ANTES de a nota ser
  --     gravada (é a ordem do composer), como o passo 2 cobre o envio.
  --     Uma linha `pending`/`failed` em curso segura o caminho; `deleted`/
  --     `skipped` não, pelo mesmo motivo escrito no passo 2 (caminho reuso).
  --     Anexo de negócio (#3229) mora no MESMO bucket, sob `{org}/leads/...`,
  --     e quem segura o caminho é `crm_lead_attachments.storage_path`: sem o
  --     `not exists` dele o anexo vivo viraria órfão; sem o `'leads'` o arquivo
  --     do negócio apagado (a linha cai em cascata) ficaria para sempre.
  with orfaos_da_nota as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'internal-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.organizations g where g.id::text = split_part(o.name, '/', 1))
       and (
         split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or split_part(o.name, '/', 2) = 'leads'
       )
       and not exists (
         select 1 from public.conversation_notes n where n.media_storage_path = o.name
       )
       and not exists (
         select 1 from public.crm_lead_attachments a where a.storage_path = o.name
       )
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'internal-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila_da_nota as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'internal-media', caminho from orfaos_da_nota
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas_nota from fila_da_nota;
  v_orfas := v_orfas + v_orfas_nota;

  -- 2c. RETENÇÃO POR IDADE DO ANEXO DA NOTA VIVA (#1887). Até aqui o bucket
  --     `internal-media` só era alcançado quando a nota SUMIA (passo 2b) ou
  --     sob pedido LGPD (passo 6d da 0483): uma nota que CONTINUA EXISTINDO
  --     segurava o anexo para sempre, e numa cota de 1 GB dividida com
  --     `whatsapp-media` o bucket crescia sem teto — anexos de até 50 MB
  --     (issue #1887; opção A, decisão do mantenedor no PR #2309).
  --     O anexo interno passa a seguir a MESMA regra da mídia de conversa:
  --     mesmo knob (`organizations.media_retention_days`, piso de 30 dias),
  --     MESMO interruptor (`media_retention_enforced`, 0557) e MESMA pausa
  --     enquanto a organização tem pedido LGPD em andamento — sem os dois, o
  --     anexo de nota seria a ÚNICA coisa apagada numa organização que
  --     desligou a limpeza, ou no meio de um atendimento LGPD. Mesmo desenho
  --     do passo 1 — a idade é a da NOTA, a mesma
  --     medida que a da mensagem, e o arquivo só sai DEPOIS do knob. Nota
  --     viva dentro da retenção não é tocada; é esta linha que o teste de
  --     #1887 cobra (e que reprova se a condição de idade sumir).
  --     Os três ponteiros são zerados como no passo 6d da 0483: a nota fica
  --     com o texto e sem card apontando para arquivo que já saiu do bucket.
  --     Arquivo já removido à mão não quebra a rodada: a linha entra como
  --     `pending` e o worker a fecha como `skipped`, como no passo 1.
  --     Aqui não existe o "nenhuma OUTRA mensagem usa" do passo 1: o caminho
  --     de anexo é único por upload (`note-<uuid>.<ext>`). A rota de nota só
  --     confere que o caminho é da mesma conversa, então duas notas PODEM
  --     apontar para o mesmo arquivo por chamada direta à API (pela tela não
  --     acontece); nesse caso a mais nova perde o anexo quando a mais velha
  --     vence — caso raro, aceito na decisão.
  with vencidas_da_nota as (
    select n.id, n.organization_id, n.media_storage_path as caminho,
           greatest(coalesce(o.media_retention_days, 365), 30) as retencao_dias
      from public.conversation_notes n
      join public.organizations o on o.id = n.organization_id
     where n.media_storage_path is not null
       and o.media_retention_enforced
       and n.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = n.organization_id
            and r.status in ('received', 'processing')
       )
     order by n.created_at
     limit v_lim
     for update of n skip locked
  ), fila_da_retencao as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct v.organization_id, 'internal-media', v.caminho
      from vencidas_da_nota v
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas_da_nota as (
    update public.conversation_notes n
       set media_storage_path = null,
           media_mime = null,
           media_size_bytes = null,
           -- 9050 do upstream (#3756): o rastro que a tela lê na nota.
           media_expired_at = now(),
           media_retention_days = v.retencao_dias
      from vencidas_da_nota v
     where n.id = v.id
    returning 1
  )
  select count(*) into v_vencidas_nota from limpas_da_nota;
  v_vencidas := v_vencidas + v_vencidas_nota;
  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas, 'expurgadas', v_expurgadas);
end;
$function$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;

-- importacoes_de_historico: a 9102 (dev) troca o grant da tabela por grant por coluna,
-- montado com as colunas que existem quando ela roda. Onde a 9102 rodou antes da 9033
-- do upstream, as colunas novas (escopo, origem, desde, ate...) ficariam sem leitura.
-- Mesmo bloco da 9102, de novo, depois das duas.
do $grants_importacoes$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'importacoes_de_historico' and column_name <> 'credencial_cifrada';
  revoke select on public.importacoes_de_historico from authenticated;
  execute format('grant select (%s) on public.importacoes_de_historico to authenticated', cols);
end $grants_importacoes$;

-- fn_mesclar_contatos: a 9049 do upstream (30/10, subida 1.95) recriou a função
-- inteira e apagou o remendo por âncora da nossa 9010 (herança do IGSID e do @ do
-- Instagram na fusão). O baseline aplica a 9010 depois e não perdia; a cadeia, e
-- a produção, perdiam. Mesmo bloco da 9010, de novo: ele pula quando já herda.
do $mig$
declare
  v_def text;
  v_ancora text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_mesclar_contatos';

  if v_def is null then
    raise notice '9010: fn_mesclar_contatos nao existe nesta instalacao — heranca fica para quem a tiver';
    return;
  end if;

  if position('v_igsid' in v_def) > 0 then
    raise notice '9010: a fusao ja herda o IGSID — nada a fazer';
    return;
  end if;

  v_ancora := '  v_lid text;';
  perform public.fn_9010_ancora_unica(v_def, v_ancora, 'declaracao de v_lid em fn_mesclar_contatos');

  v_def := replace(
    v_def,
    v_ancora,
    v_ancora || chr(10) || '  v_igsid text;' || chr(10) || '  v_username text;'
  );

  -- Colhe do perdedor mais antigo, como os outros campos fazem, e reusa a
  -- guarda de unicidade: a lápide já soltou o IGSID do índice, então o que
  -- sobrar aqui é conflito com um TERCEIRO contato vivo — e nesse caso o
  -- vencedor simplesmente não herda, em vez de a fusão inteira falhar.
  v_ancora := '  select coalesce(array_agg(distinct t)';
  perform public.fn_9010_ancora_unica(v_def, v_ancora, 'bloco de tags em fn_mesclar_contatos');

  v_def := replace(
    v_def,
    v_ancora,
    '  select c.instagram_igsid into v_igsid from public.contacts c' || chr(10) ||
    '   where c.id = any(p_contatos_secundarios) and c.instagram_igsid is not null' || chr(10) ||
    '   order by c.created_at, c.id limit 1;' || chr(10) ||
    '  select c.instagram_username into v_username from public.contacts c' || chr(10) ||
    '   where c.id = any(p_contatos_secundarios) and c.instagram_username is not null' || chr(10) ||
    '   order by c.created_at, c.id limit 1;' || chr(10) ||
    '  if v_igsid is not null and exists (' || chr(10) ||
    '    select 1 from public.contacts o' || chr(10) ||
    '     where o.organization_id = p_organization_id and o.is_merged_into is null' || chr(10) ||
    '       and o.id <> p_contato_principal and o.instagram_igsid = v_igsid' || chr(10) ||
    '  ) then v_igsid := null; end if;' || chr(10) ||
    '  -- Abre a escotilha da trigger de identidade para ESTA transacao. Sem' || chr(10) ||
    '  -- isto a heranca logo abaixo levanta 42501 e a fusao inteira aborta:' || chr(10) ||
    '  -- SECURITY DEFINER troca o papel e NAO troca auth.uid().' || chr(10) ||
    '  perform set_config(''deskcomm.identidade_de_instagram'', ''on'', true);' || chr(10) ||
    v_ancora
  );

  -- Escreve no vencedor. `coalesce` porque o principal MANDA: ele herda só o
  -- que não tinha, nunca sobrescreve o que o atendente digitou.
  v_ancora := '    phone_number = coalesce(phone_number, v_telefone),';
  perform public.fn_9010_ancora_unica(v_def, v_ancora, 'update do vencedor em fn_mesclar_contatos');

  v_def := replace(
    v_def,
    v_ancora,
    v_ancora || chr(10) ||
    '    instagram_igsid = coalesce(instagram_igsid, v_igsid),' || chr(10) ||
    '    instagram_username = coalesce(instagram_username, v_username),'
  );

  -- FECHA a escotilha logo depois do uso.
  --
  -- `set_config(..., true)` e TRANSACAO-local, nao statement-local. Deixada
  -- aberta, ela vale pelo resto da transacao — e qualquer escrita posterior no
  -- mesmo request passaria pela trava. Medido no ensaio: sem este reset, um
  -- `update contacts set instagram_igsid` logo apos a fusao era ACEITO.
  --
  -- A janela certa e a menor possivel: abre antes do update do vencedor, fecha
  -- depois dele.
  v_ancora := '  -- 7 · A fusão aparece na timeline';
  perform public.fn_9010_ancora_unica(v_def, v_ancora, 'inicio do passo 7 em fn_mesclar_contatos');

  v_def := replace(
    v_def,
    v_ancora,
    '  perform set_config(''deskcomm.identidade_de_instagram'', ''off'', true);' || chr(10) ||
    v_ancora
  );

  execute v_def;
end $mig$;

-- fn_definir_aviso_de_caso / fn_definir_aviso_de_agendamento: a 9231 da dev (06/11)
-- recriou as duas pelas assinaturas ANTIGAS (7 e 6 argumentos) com a exceção da
-- conexão da própria org; o upstream 1.99 já tinha trocado as assinaturas (9078:
-- destino_modo + responsáveis; 9060: grupo). Numa instalação nova a 9231 roda
-- depois e devolve as sobrecargas velhas. Aqui: as velhas saem e as do upstream
-- ganham a exceção da 9231 (só no destino fixo; o WhatsApp do responsável segue
-- recusado quando é número da própria org).
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean);
drop function if exists public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean);

create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_resposta_whatsapp_habilitada boolean default false,
  p_destino_modo text default 'fixo',
  p_responsaveis jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes public.config_aviso_de_caso;
  v_arch timestamptz;
  v_digitos text;
  v_variantes text[];
  v_modo text;
  v_item jsonb;
  v_uid uuid;
  v_numero text;
  v_digitos_do_membro text;
  v_variantes_do_membro text[];
begin
  -- Papel + suporte, nesta ordem e na MESMA transação da escrita. `auth.uid()`
  -- nulo é o caminho do service role: quem escreve configuração é gente.
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_caso_forbidden' using errcode = '42501';
  end if;
  -- Quem NÃO tem fator cadastrado passa: a função já trata isso, e é coerente
  -- com a política de MFA opcional deste produto.
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_caso_mfa_required' using errcode = '42501';
  end if;
  if p_telefone is null or p_telefone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'aviso_de_caso_telefone_invalido' using errcode = '22023';
  end if;

  -- O modo é vocabulário FECHADO: um valor fora dos dois que o motor conhece
  -- deixaria a tela dizendo uma coisa e o envio fazendo outra.
  v_modo := coalesce(nullif(btrim(p_destino_modo), ''), 'fixo');
  if v_modo not in ('fixo', 'responsavel') then
    raise exception 'aviso_de_caso_destino_invalido' using errcode = '22023';
  end if;

  -- O canal é DA organização e não está arquivado. Sem isto a FK simples
  -- deixaria apontar para o canal de outro tenant — a FK composta do padrão
  -- 0228 não serve aqui porque o `on delete set null` anularia também
  -- `organization_id`, que é a chave primária desta tabela.
  if p_channel is not null then
    select archived_at into v_arch
      from public.channel_sessions
     where id = p_channel and organization_id = p_org;
    if not found or v_arch is not null then
      raise exception 'aviso_de_caso_canal_invalido' using errcode = '22023';
    end if;
  end if;

  -- As duas grafias do nono dígito — a MESMA regra de
  -- `lib/channels/phone-variants.ts`. Comparar a string crua deixaria passar o
  -- número do suporte cadastrado com 9 e registrado sem.
  v_digitos := regexp_replace(p_telefone, '\D', '', 'g');
  v_variantes := array[v_digitos];
  if v_digitos like '55%' then
    if length(v_digitos) = 13
       and substring(v_digitos from 5 for 1) = '9'
       and substring(v_digitos from 6 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || substring(v_digitos from 6));
    elsif length(v_digitos) = 12
       and substring(v_digitos from 5 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || '9' || substring(v_digitos from 5));
    end if;
  end if;

  -- O NÚMERO DE AVISO NÃO PODE SER UM NÚMERO DA PRÓPRIA ORGANIZAÇÃO. É o laço
  -- robô-com-robô: a conexão de avisos manda para o número oficial, o agente
  -- dele responde, e as duas pontas se alimentam sem fim.
  -- A conexão ARQUIVADA fica FORA da conta. Ela não envia nem recebe, então o
  -- laço não acontece por ela — e contá-la bloqueia o número PARA SEMPRE, porque
  -- a conexão que já teve agente publicado não pode ser apagada (as versões a
  -- seguram) e o número nunca mais poderia receber aviso.
  if exists (
       select 1 from public.channel_sessions s
        where s.organization_id = p_org
          and s.archived_at is null
          and s.phone_number is not null
          and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes)
          -- 9231 (dev): com a exceção da organização ligada, só a PRÓPRIA conexão remetente
          -- bloqueia (mandar para si mesma). Sem remetente, a regra antiga vale.
          and (p_channel is null or s.id = p_channel
               -- remetente sem número conhecido: não dá para provar que não é o destino.
               or not exists (select 1 from public.channel_sessions r
                               where r.id = p_channel and r.organization_id = p_org and r.phone_number is not null)
               or not coalesce((select o.aviso_para_conexao_propria from public.organizations o
                                 where o.id = p_org), false))) then
    raise exception 'aviso_de_caso_numero_da_propria_org' using errcode = '22023';
  end if;

  -- O número de aviso vira INTERNO: tudo o que chegar dele deixa de virar
  -- contato, conversa, lead e despacho do agente. Se ele já é um CLIENTE desta
  -- organização, as mensagens dessa pessoa param de chegar ao CRM — e isso não
  -- pode acontecer por engano. A tela pergunta e reenvia com `p_confirma_contato`.
  if not coalesce(p_confirma_contato, false) and exists (
       select 1 from public.contacts c
        where c.organization_id = p_org
          and c.phone_number is not null
          and regexp_replace(c.phone_number, '\D', '', 'g') = any (v_variantes)) then
    raise exception 'aviso_de_caso_numero_de_cliente' using errcode = '22023';
  end if;

  -- ─── O WhatsApp de cada pessoa da equipe (#3803) ─────────────────────────
  --
  -- Só membro ATIVO da organização é gravado: número de quem saiu da equipe não
  -- recebe aviso, e aceitá-lo aqui daria um destino que nunca é resolvido.
  -- Vazio (`''` ou nulo) É uma informação — significa "esta pessoa não tem
  -- número" —, e por isso grava nulo em vez de recusar.
  if p_responsaveis is not null then
    if jsonb_typeof(p_responsaveis) <> 'array' then
      raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_responsaveis) loop
      v_uid := nullif(btrim(coalesce(v_item ->> 'user_id', '')), '')::uuid;
      if v_uid is null then
        raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
      end if;
      v_numero := nullif(btrim(coalesce(v_item ->> 'whatsapp', '')), '');
      if v_numero is not null then
        -- O mesmo "dígitos com `+` na frente" que a tela normaliza
        -- (`normalizarTelefoneDeAviso`): quem manda `31 99888-7777` recebe o
        -- número guardado na forma canônica em vez de um 22023 que não explica.
        v_numero := '+' || regexp_replace(v_numero, '\D', '', 'g');
        if v_numero !~ '^\+[1-9][0-9]{7,14}$' then
          raise exception 'aviso_de_caso_whatsapp_invalido' using errcode = '22023';
        end if;
        -- No modo `responsavel` este número É o destino do aviso. Um número
        -- conectado desta organização abriria por aqui o mesmo laço
        -- robô-com-robô que a guarda do número da empresa fecha: mesma conta
        -- (conexão ativa, as duas grafias do nono dígito) e mesmo código.
        v_digitos_do_membro := regexp_replace(v_numero, '\D', '', 'g');
        v_variantes_do_membro := array[v_digitos_do_membro];
        if v_digitos_do_membro like '55%' then
          if length(v_digitos_do_membro) = 13
             and substring(v_digitos_do_membro from 5 for 1) = '9'
             and substring(v_digitos_do_membro from 6 for 1) between '6' and '9' then
            v_variantes_do_membro := v_variantes_do_membro
              || (substring(v_digitos_do_membro from 1 for 4) || substring(v_digitos_do_membro from 6));
          elsif length(v_digitos_do_membro) = 12
             and substring(v_digitos_do_membro from 5 for 1) between '6' and '9' then
            v_variantes_do_membro := v_variantes_do_membro
              || (substring(v_digitos_do_membro from 1 for 4) || '9' || substring(v_digitos_do_membro from 5));
          end if;
        end if;
        if exists (
             select 1 from public.channel_sessions s
              where s.organization_id = p_org
                and s.archived_at is null
                and s.phone_number is not null
                and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes_do_membro)) then
          raise exception 'aviso_de_caso_numero_da_propria_org' using errcode = '22023';
        end if;
      end if;
      update public.user_organizations uo
         set whatsapp_e164 = v_numero
       where uo.organization_id = p_org
         and uo.user_id = v_uid
         and uo.revoked_at is null;
    end loop;
  end if;

  select * into v_antes from public.config_aviso_de_caso where organization_id = p_org;

  insert into public.config_aviso_de_caso
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, resposta_whatsapp_habilitada, destino_modo, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), coalesce(p_resposta_whatsapp_habilitada, false), v_modo, auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
        resposta_whatsapp_habilitada = excluded.resposta_whatsapp_habilitada,
        destino_modo       = excluded.destino_modo,
        atualizado_por     = auth.uid(),
        -- Trocou o número, o JID resolvido do anterior não vale mais — e é o
        -- JID que o corte da ingestão usa para reconhecer quem está em modo
        -- privacidade. Mantê-lo faria o corte continuar valendo para o número
        -- ANTIGO, que pode voltar a ser um cliente.
        destino_jid        = case
                               when excluded.telefone_destino is distinct from config_aviso_de_caso.telefone_destino
                               then null
                               else config_aviso_de_caso.destino_jid
                             end,
        updated_at         = now();

  return jsonb_build_object(
    'trocou_numero', (v_antes.telefone_destino is distinct from p_telefone),
    'antes_ligado',  coalesce(v_antes.ligado, false),
    'destino_modo',  v_modo
  );
end;
$$;
revoke all on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb) to authenticated;

create or replace function public.fn_definir_aviso_de_agendamento(
  p_org uuid,
  p_usa_numero_do_aviso_de_caso boolean,
  p_channel uuid,
  p_telefone text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_grupo text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes public.config_aviso_de_agendamento;
  v_arch timestamptz;
  v_digitos text;
  v_variantes text[];
  v_usa boolean := coalesce(p_usa_numero_do_aviso_de_caso, true);
  v_channel uuid := p_channel;
  v_telefone text := nullif(btrim(coalesce(p_telefone, '')), '');
  v_grupo text := nullif(btrim(coalesce(p_grupo, '')), '');
begin
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_agendamento_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_agendamento_mfa_required' using errcode = '42501';
  end if;

  if v_usa then
    -- O número do aviso de caso já passou pelas guardas da 0292 quando foi
    -- salvo. Aqui só se exige que ele EXISTA, senão a tela diria "usando o
    -- número do aviso de caso" sobre um número que não há.
    if not exists (
         select 1 from public.config_aviso_de_caso c
          where c.organization_id = p_org
            and c.channel_session_id is not null) then
      raise exception 'aviso_de_agendamento_sem_aviso_de_caso' using errcode = '22023';
    end if;
    v_channel := null;
    v_telefone := null;
  else
    if v_telefone is null or v_telefone !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'aviso_de_agendamento_telefone_invalido' using errcode = '22023';
    end if;
    if v_channel is null then
      raise exception 'aviso_de_agendamento_canal_invalido' using errcode = '22023';
    end if;
    select archived_at into v_arch
      from public.channel_sessions
     where id = v_channel and organization_id = p_org;
    if not found or v_arch is not null then
      raise exception 'aviso_de_agendamento_canal_invalido' using errcode = '22023';
    end if;

    -- As duas grafias do nono dígito — a MESMA regra da 0292 e de
    -- `lib/channels/phone-variants.ts`.
    v_digitos := regexp_replace(v_telefone, '\D', '', 'g');
    v_variantes := array[v_digitos];
    if v_digitos like '55%' then
      if length(v_digitos) = 13
         and substring(v_digitos from 5 for 1) = '9'
         and substring(v_digitos from 6 for 1) between '6' and '9' then
        v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || substring(v_digitos from 6));
      elsif length(v_digitos) = 12
         and substring(v_digitos from 5 for 1) between '6' and '9' then
        v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || '9' || substring(v_digitos from 5));
      end if;
    end if;

    -- O número de destino NÃO pode ser de uma conexão da própria organização:
    -- é o laço robô-com-robô (a conexão avisa o número oficial, o agente dele
    -- responde, e as duas pontas se alimentam).
    if exists (
         select 1 from public.channel_sessions s
          where s.organization_id = p_org
            and s.archived_at is null
            and s.phone_number is not null
            and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes)
            -- 9231 (dev): com a exceção da organização ligada, só a PRÓPRIA conexão remetente
            -- bloqueia (mandar para si mesma). Sem remetente, a regra antiga vale.
            and (v_channel is null or s.id = v_channel
                 -- remetente sem número conhecido: não dá para provar que não é o destino.
                 or not exists (select 1 from public.channel_sessions r
                                 where r.id = v_channel and r.organization_id = p_org and r.phone_number is not null)
                 or not coalesce((select o.aviso_para_conexao_propria from public.organizations o
                                   where o.id = p_org), false))) then
      raise exception 'aviso_de_agendamento_numero_da_propria_org' using errcode = '22023';
    end if;

    -- O número de aviso vira INTERNO (o que chega dele não vira atendimento).
    -- Se ele já é um cliente, isso não pode acontecer por engano.
    if not coalesce(p_confirma_contato, false) and exists (
         select 1 from public.contacts c
          where c.organization_id = p_org
            and c.phone_number is not null
            and regexp_replace(c.phone_number, '\D', '', 'g') = any (v_variantes)) then
      raise exception 'aviso_de_agendamento_numero_de_cliente' using errcode = '22023';
    end if;
  end if;

  -- O grupo é destino EXTRA, da mesma conexão que envia. Só a forma é
  -- conferida aqui: se o número saiu do grupo, o envio cai só para ele.
  if v_grupo is not null and v_grupo !~ '^[0-9-]+@g\.us$' then
    raise exception 'aviso_de_agendamento_grupo_invalido' using errcode = '22023';
  end if;

  select * into v_antes from public.config_aviso_de_agendamento where organization_id = p_org;

  insert into public.config_aviso_de_agendamento
    (organization_id, usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, grupo_destino, ligado, criado_por, atualizado_por)
  values
    (p_org, v_usa, v_channel, v_telefone, v_grupo, coalesce(p_ligado, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set usa_numero_do_aviso_de_caso = excluded.usa_numero_do_aviso_de_caso,
        channel_session_id          = excluded.channel_session_id,
        telefone_destino            = excluded.telefone_destino,
        grupo_destino               = excluded.grupo_destino,
        ligado                      = excluded.ligado,
        atualizado_por              = auth.uid(),
        updated_at                  = now();

  return jsonb_build_object(
    'trocou_numero', (v_antes.telefone_destino is distinct from v_telefone
                      or v_antes.usa_numero_do_aviso_de_caso is distinct from v_usa),
    'antes_ligado',  coalesce(v_antes.ligado, false)
  );
end;
$$;
revoke all     on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean,text) from public, anon;
grant  execute on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean,text) to authenticated;

-- channel_sessions_provider_ref_check: a cadeia terminava na escrita da 9023 e o
-- baseline em outra (mesma regra). Recriada com a escrita do baseline, para os dois
-- caminhos chegarem ao mesmo catálogo.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    -- 'zernio_social' (migration 0368) endereça pelo MESMO `zernio_account_id`:
    -- é o mesmo intermediário, com outra superfície de canal.
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'verdash'    and verdash_instance_name is not null) or
    -- Instagram usa a MESMA coluna de endereçamento: o transporte passa pela Verdash, o
    -- que muda é o canal, não o caminho.
    (provider = 'instagram'  and verdash_instance_name is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null)
  );

notify pgrst, 'reload schema';
