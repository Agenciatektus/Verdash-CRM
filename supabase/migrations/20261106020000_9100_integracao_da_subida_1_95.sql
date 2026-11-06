-- manifest: 9100 — Tektus: a subida do upstream 1.95 sem um lado apagar o outro. Roda por último e deixa a versão INTEGRADA do que os dois lados redefinem: conversations_select de conjunto da 9027 com o ramo de PARTICIPANTE do atendimento conjunto (0661/9016); fn_lgpd_cascade_redact_contact da 9043 do upstream (telefones extras, propostas de campos da 0772/0797) com a identidade do Instagram e a transcrição (9023/9058/9099); fn_solicitar_reenvio_conversao com o LeadSubmitted da 0803 e a régua da compra da 9054/9055; fn_vocabulario_de_tags_operar da 9059 com o marcador minúsculo da 9023 do upstream (#3507). Idempotente.
--
-- 9100: integração da subida do upstream 1.95 (mesmo defeito de ordem da 9099).
--
--   objeto                            upstream          fork
--   conversations_select              0661/9016         9027/9099
--   fn_lgpd_cascade_redact_contact    0772/0797/9043    9023/9058/9099
--   fn_solicitar_reenvio_conversao    0803              9054/9055
--   fn_vocabulario_de_tags_operar     9023              9038/9058/9059

-- ---- 1. conversations_select: a de conjunto da 9027 + o ramo de participante (0661/9016) ----
do $rls9100$ begin
  drop policy if exists "conversations_select" on public.conversations;
  create policy "conversations_select" on public.conversations
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
        select e.organization_id from public.fn_escopo_orgs() e
         where e.papel in ('viewer', 'manager', 'admin')
            or (e.papel = 'agent' and e.modo = 'all'))
      or (assigned_to_user_id = (select auth.uid())
          and organization_id in (
            select e.organization_id from public.fn_escopo_orgs() e
             where e.papel = 'agent'))
      or (assigned_to_user_id is null
          and organization_id in (
            select e.organization_id from public.fn_escopo_orgs() e
             where e.papel = 'agent' and e.modo = 'own_and_unassigned'))
      -- 0661/9016 (upstream): quem foi convidado ao atendimento conjunto lê a conversa
      -- enquanto participa, menos a de contato pessoal.
      or exists (
           select 1
             from public.conversation_participants cp
            where cp.conversation_id = conversations.id
              and cp.organization_id = conversations.organization_id
              and cp.user_id = (select auth.uid())
              and cp.left_at is null
              and not exists (
                select 1 from public.contacts pc
                 where pc.id = conversations.contact_id
                   and pc.organization_id = conversations.organization_id
                   and pc.is_personal
              )
         )
    );
end $rls9100$;

-- ---- 2. fn_lgpd_cascade_redact_contact: 9043 do upstream + Instagram e transcrição do fork ----
create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_variantes text[] := '{}';
  v_secao record;
  v_secoes jsonb := '{}'::jsonb;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  -- O rótulo NÃO deriva mais do id (issue #2342): `fn_lgpd_rotulo_anonimizado`
  -- gera um sufixo OPACO (aleatório, gravado no passo 1 abaixo). Antes, o
  -- sufixo eram os 8 primeiros caracteres do uuid do contato — quem tem o
  -- banco casava `Cliente Anonimizado #7a5f0011` com a linha `7a5f0011-…` e
  -- reidentificava o titular pelo próprio rótulo (pseudonimização, não
  -- anonimização: RGPD considerando 26, LGPD art. 12 e art. 13 §4).
  v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id);

  -- Seções de módulo (D8, 0485): a redação delas é do gatilho
  -- `trg_lgpd_secoes_de_modulo`, que não devolve contagem — mas a contagem é
  -- EVIDÊNCIA (vai para `cascaded_to` no audit e no retorno). Uma chave por
  -- seção declarada, com o nome da tabela, contando pela MESMA `ligacao` do
  -- gatilho ($1 = organização, $2 = contato). Conta ANTES do passo 1 (que
  -- dispara o gatilho): a seção que soltar a própria ligação seguiria contada.
  -- Sem o módulo a tabela não existe e a chave não aparece. Seção com ligação
  -- vazia não é contada: o erro nomeado (`modulo_secao_invalida`) é do gatilho.
  for v_secao in
    select tabela, ligacao from public.modulo_secoes_lgpd order by modulo, tabela
  loop
    if to_regclass(format('public.%I', v_secao.tabela)) is not null
       and btrim(v_secao.ligacao) <> '' then
      execute format('select count(*) from public.%I where (%s)', v_secao.tabela, v_secao.ligacao)
        into v_count using p_organization_id, p_contact_id;
      v_secoes := v_secoes || jsonb_build_object(v_secao.tabela, v_count);
    end if;
  end loop;

  -- (9043) As variantes do principal E dos telefones extras, lidas ANTES de
  -- apagar os extras (passo 1b): o candidato da prospecção casado pelo número
  -- extra também é da pessoa que pediu para ser esquecida.
  select coalesce(array_agg(distinct v), '{}')
    into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(c.phone_number)) as v
        from contacts c
       where c.id = p_contact_id and c.organization_id = p_organization_id
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from contact_phones t
       where t.contact_id = p_contact_id and t.organization_id = p_organization_id
    ) as todas;

  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    phone_type = null,
    phone_whatsapp = null,
    -- 9023/9058: a identidade de Instagram do fork (o `@` e o id estável que a
    -- Meta emite para a pessoa). A 0620, a 0657 e a 9043 reemitiram a função sem ela.
    instagram_igsid = null,
    instagram_username = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 1b. contact_phones (9043) — os telefones extras, com o `lid` de cada um.
  -- Depois do passo 1: o gatilho de redação das mensagens de grupo, que roda
  -- no `update` acima, ainda precisava lê-los.
  delete from contact_phones
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_phones', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    -- `external_id` guarda o TELEFONE do titular (número no inbound, id do
    -- provider no outbound) e sobrevivia legível na linha que RESTA da
    -- anonimização — a última PII viva do pedido de exclusão. Zerar não quebra
    -- nada que dependa da coluna: o unique (organization_id, external_id)
    -- trata NULL como distinto de todo NULL, a citação (`reply_to_message_id`)
    -- aponta para o id da linha e não para o `external_id`, e o eco do provider
    -- só deduplica mensagem ainda em voo — pedido de exclusão não manda nada.
    external_id = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);
  -- 5b. lead_field_proposals (0772, #3316) — a proposta de campo que a IA leu
  -- num DOCUMENTO (voucher, bilhete, apólice). `trecho` é o texto do documento
  -- sobre a PESSOA e os dois valores são o dado que a IA extraiu: o MESMO
  -- tratamento do `custom_fields` do próprio negócio (passo 5) — campo, status
  -- e decisão PERMANECEM (a fila continua explicável), o conteúdo identificável
  -- sai. Alcança pelo vínculo do negócio com o contato (direto ou pela
  -- `crm_lead_links`), como os passos 4 e 5.
  -- Gate: tests/invariants/cascata-lgpd-nao-encolhe.test.ts (catraca da lista).
  update lead_field_proposals set
    trecho = v_anon_label,
    valor_proposto = null,
    valor_anterior = null,
    motivo_recusa = null,
    updated_at = now()
  where organization_id = p_organization_id
    and (
      lead_id in (
        select id from crm_leads
         where organization_id = p_organization_id
           and contact_id = p_contact_id
      )
      or lead_id in (
        select lead_id from crm_lead_links
         where target_kind = 'contact'
           and target_id = p_contact_id
           and organization_id = p_organization_id
      )
    )
    -- Redação IDEMPOTENTE: a segunda anonimização não deve contar linha de novo
    -- (o `already_anonymized` já barra, mas a condição também protege o rerun
    -- parcial que a 0414 permite).
    and (trecho is distinct from v_anon_label
         or valor_proposto is not null
         or valor_anterior is not null
         or motivo_recusa is not null);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('lead_field_proposals', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 6b. crm_proposals (migration 0477, #1504) — PRESERVA número, valores,
  -- itens, datas e status; redige só o que identifica a PESSOA. Ver o
  -- cabeçalho desta migration para o porquê de cada coluna.
  -- O PDF que o cliente recebeu (bucket `propostas`, `<org>/<proposta>.pdf`)
  -- tem o nome dele impresso: redigir as colunas e deixar o arquivo seria
  -- anonimizar a linha e manter o documento. Vai para a mesma fila de expurgo
  -- da mídia (passo 7), com o bucket CERTO — a mensagem que levou o PDF
  -- aponta para o mesmo caminho, mas o passo 7 só enfileira `whatsapp-media`.
  -- Lido ANTES de o passo seguinte zerar `pdf_path`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'propostas', pdf_path
    from crm_proposals
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and pdf_path is not null and length(pdf_path) > 0
     -- só arquivo DESTA organização: o expurgo nunca alcança o PDF de outra
     and pdf_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update crm_proposals set
    destinatario_nome = v_anon_label,
    briefing_json = '{}'::jsonb,
    resumo_comercial = null,
    -- o texto do documento como foi montado e como foi editado à mão: é o
    -- conteúdo do PDF, com o mesmo nome dentro.
    rendered_snapshot = null,
    secoes_editadas = null,
    pdf_path = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_proposals', v_count);

  -- CAMPANHAS: o que foi DITO à pessoa e o endereço para onde foi.
  update campaign_recipients set
    rendered_body = null,
    recipient_address = null,
    variables = '{}'::jsonb,
    last_error_detail = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_recipients', v_count);

  -- LISTA DE EXCLUSÃO: solta o vínculo e apaga a cauda do telefone.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);

  -- 6c. sales — a comanda SAIU desta cascata (PR #1907, item 1).
  -- Este passo alterava a comanda pelo NOME, e as cinco tabelas da comanda
  -- saíram do baseline para nascerem só na instalação do módulo (ADR-0002
  -- D2/D3): sem o módulo a tabela não existe e a alteração abortava a
  -- ANONIMIZAÇÃO INTEIRA com `relation "sales" does not exist` — 68
  -- ocorrências no CI do #1907 — além de violar a D8 (migration 0485), que
  -- proíbe o núcleo nomear tabela de módulo. A redação da comanda acontece
  -- agora pela SEÇÃO declarada `financeiro/sales` em `modulo_secoes_lgpd`,
  -- que `trg_lgpd_secoes_de_modulo` aplica nos DOIS caminhos de anonimização
  -- (a cascata e a virada `is_anonymized` de `fn_lgpd_anonymize_contact`) —
  -- e pula, sem erro, onde o módulo não está instalado (`to_regclass`), que é
  -- exatamente o contrato.
  -- 6d. conversation_notes (migration 0483, F3 da #1863) — a nota interna é
  -- texto escrito SOBRE a pessoa durante o atendimento, e o anexo dela é mídia
  -- ancorada na conversa: os dois entram no alcance do titular. A 0477 já
  -- mostrou o desenho (arquivo vai para a fila ANTES de a coluna ser zerada).
  -- O bucket é `internal-media`, e não o do passo 7: a nota nunca sobe no
  -- `whatsapp-media` (é o bucket do canal do CLIENTE), e enfileirar o caminho
  -- num bucket onde ele não está deixaria a remoção apontando para o nada —
  -- a mesma falha de não ter anonimizado, um endereço mais para a direita.
  -- Por isso os caminhos de nota também NÃO entram em `v_media_paths`: essa
  -- lista só existe para o passo 7, que enfileira `whatsapp-media`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'internal-media', n.media_storage_path
    from conversation_notes n
   where n.organization_id = p_organization_id
     and n.conversation_id in (
       select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
     )
     and n.media_storage_path is not null and length(n.media_storage_path) > 0
     and n.media_storage_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
       where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversation_notes', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    -- 9008/9023/9058: O QUE FOI DITO na chamada (quase sempre o nome da pessoa).
    -- A 0620, a 0657 e a 9043 reemitiram a função sem esta linha.
    transcript = null,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  update prospecting_candidates set suppression_salt = gen_random_bytes(32)
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)))
    and suppression_salt is null;
  update prospecting_candidates set
    suppression_place = hmac(convert_to(place_id, 'UTF8'), suppression_salt, 'sha256'),
    suppression_phone = case when phone is null then null
      else hmac(convert_to(phone, 'UTF8'), suppression_salt, 'sha256') end,
    place_id = 'redacted:' || id::text,
    phone = null,
    data = jsonb_build_object('key', 'redacted:' || id::text,
      'name', v_anon_label, 'phone', null, 'website', null,
      'category', null, 'address', null, 'maps_url', null,
      'rating', null, 'reviews', null, 'emails', '[]'::jsonb, 'socials', '[]'::jsonb),
    status = 'skipped', service_boundary = null, error = null, updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('prospecting_candidates', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- agent_case_events — a linha do tempo do caso (migration 0280).
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- demandas — o assunto do pedido (migration 0280).
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280/0292).
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind in ('handoff', 'case_stale', 'aviso_de_caso_nao_entregue')
    and (
      (ref_kind = 'contact' and ref_id = p_contact_id)
      or (ref_kind = 'conversation' and ref_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          ))
      or (ref_kind = 'agent_case' and ref_id in (
            select id from agent_cases
              where organization_id = p_organization_id
                and conversation_id in (
                  select id from conversations
                    where contact_id = p_contact_id and organization_id = p_organization_id
                )
          ))
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso (migration 0281).
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  update entregas_de_aviso_de_caso set
    erro_detalhe = null
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('entregas_de_aviso_de_caso', v_count);

  -- channel_session_groups.subject — o NOME do grupo, e a FK contact_id aponta
  -- para o placeholder do grupo (contacts.kind = 'whatsapp_group'), nunca para
  -- o titular real sendo anonimizado neste caminho — mas a FK para contacts e o
  -- nome da coluna casam o padrão automático do escopo (migration 0482), e
  -- nulificar não perde nada operacional: número, conversa e liga/desliga ficam.
  update public.channel_session_groups set
    subject = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('channel_session_groups', v_count);

  -- 7z. as contagens das seções de módulo (calculadas antes do passo 1); o
  --     núcleo vence numa colisão de nome.
  v_counts := v_secoes || v_counts;

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

-- ---- 3. fn_solicitar_reenvio_conversao: LeadSubmitted (0803) + régua da compra (9054/9055) ----
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid, p_event text)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  -- 0524 (upstream): os eventos de etapa da Meta (`MetaEtapa:<uuid>`) também se
  -- reenviam, exigindo o retrato (quando + qual evento). A régua da compra é a
  -- da 9054 (ganho OU etapa ligada com `Purchase`). Integrado na 9055;
  -- o `LeadSubmitted` da 0803 (upstream) entra na 9100.
  if p_event is null or not (
    p_event in ('Purchase', 'QualifiedLead', 'LeadSubmitted')
    or p_event ~ '^Etapa:[0-9a-f-]{36}$'
    or p_event ~ '^MetaEtapa:[0-9a-f-]{36}$'
  ) then
    return false;
  end if;
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = p_event for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if p_event = 'LeadSubmitted' then
    if v_linha.platform <> 'meta_ads' or v_linha.event_occurred_at is null
       or v_linha.event_id is distinct from p_lead::text || ':LeadSubmitted'
       or v_linha.meta_event_name is distinct from 'LeadSubmitted'
       or (v_linha.claim_token is not null and v_linha.claimed_until > now())
       then return false; end if;
  elsif p_event ~ '^MetaEtapa:' then
    if v_linha.event_occurred_at is null or v_linha.meta_event_name is null then return false; end if;
  elsif p_event <> 'Purchase' and (v_linha.event_occurred_at is null or v_linha.google_action_id is null) then
    return false;
  end if;
  if p_event = 'Purchase' and v_linha.remote_request_id is null and not exists (
    select 1 from public.crm_leads l
      left join public.crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
     where l.id = p_lead and l.organization_id = p_org
       and (l.status = 'won' or (s.envia_conversao and s.evento_de_conversao = 'Purchase'))
  ) then return false; end if;
  if exists (select 1 from public.event_log where organization_id = p_org and entity_id = p_lead
    and event_type = 'ad_conversion.retry_requested' and status in ('pending', 'processing')
    and coalesce(payload->>'event_name', 'Purchase') = p_event) then return false; end if;
  perform public.emit_event('ad_conversion.retry_requested', 'crm_lead', p_lead,
    jsonb_build_object('event_name', p_event), '{}'::jsonb, p_org);
  update public.ad_conversion_dispatches set reason = 'reprocessamento_solicitado', attempted_at = now()
    where id = v_linha.id and organization_id = p_org;
  return true;
end;
$$;

revoke execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) to service_role;

-- ---- 4. fn_vocabulario_de_tags_operar: 9059 do fork + marcador minúsculo da 9023 do upstream ----
create or replace function public.fn_vocabulario_de_tags_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text,
  p_cor text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tag     text := btrim(coalesce(p_tag, ''));
  v_destino text := btrim(coalesce(p_destino, ''));
  -- A cor entra normalizada (minúscula, sem espaço). A rota valida com Zod antes;
  -- esta linha defende o caminho que NÃO passa por ela — RPC direta, psql, um
  -- cliente futuro. Sem isso, `#FFF` gravaria e a comparação por igualdade da
  -- tela (que compara o que o servidor devolveu) passaria a mentir.
  v_cor     text := lower(btrim(coalesce(p_cor, '')));
  -- ── A RÉGUA DO MARCADOR, DERIVADA UMA VEZ (issue #3507) ────────────────────
  --
  -- `contacts.tags` e `conversations.tags` guardam a etiqueta em minúscula:
  -- `normalizarTag` (`lib/contacts/tag-normalizada.ts`, issue #1224, migrations
  -- 0324/0335) e `conversationTagSchema` (`.trim().toLowerCase()`,
  -- `lib/schemas/messaging.ts`), e é nessa forma que o filtro `?tag=` consulta.
  -- `v_destino` é o NOME DE EXIBIÇÃO e vai como foi digitado para o
  -- vocabulário, para as sementes de conversa, para as regras dos agentes e
  -- para `crm_leads.tags` (caixa mista aceita) — esta é a forma das DUAS
  -- colunas que são minúscula POR CONTRATO, e ela é `lower(btrim(...))`: a
  -- MESMA expressão com que `fn_tags_normalizar` compara o valor de origem e
  -- com que a 0335 normalizou o marcador já gravado.
  --
  -- ⚠️ Não vai para `fn_tags_normalizar`: aquela função também atende
  -- `crm_leads.tags`, que aceita caixa mista. A caixa é decisão de quem escreve
  -- na coluna que a exige, e são duas.
  --
  -- ⚠️ O TETO DE 40 DA RÉGUA NÃO ENTRA AQUI de propósito: `tagSchema` aceita 60
  -- (`TAG_MAX`) para o nome de exibição, e cortar o destino às escuras trocaria
  -- a caixa por um nome TRUNCADO — outra classe de defeito, com perda de dado.
  -- A divergência de teto entre a coluna (40, `TAMANHO_MAXIMO_DA_TAG`) e o
  -- vocabulário (60) fica declarada, não resolvida por um renomear.
  v_destino_minusculo text := lower(btrim(coalesce(p_destino, '')));
  v_remover boolean;
  v_so_cor  boolean;
  v_contatos integer := 0;
  v_leads integer := 0;
  v_conversas integer := 0;
  v_regras integer := 0;
  v_id uuid;
  v_ids uuid[];
  v_settings jsonb;
  v_antes jsonb;
  v_depois jsonb;
  v_definido boolean := false;
  -- 9038: as quatro listas de sugestão (0244/9005) e os dois escopos.
  v_chave text;
  v_escopo text;
  v_sugeridas jsonb;
  v_arquivadas jsonb;
  -- (e0) 'duas entradas do vocabulário viraram uma' — issue #2801 (0677).
  v_juntou boolean := false;
begin
  -- Portão de papel ANTES de qualquer escrita. Definer com p_org vindo da rota:
  -- é esta linha que separa o tenant de quem chama.
  if p_org is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;
  -- 9038 (7): a MESMA guarda das escritas da 9005 — sessão de suporte em modo
  -- leitura e MFA provado nesta sessão (e `auth.uid()` presente). O papel acima
  -- continua respondendo `insufficient_role`, como sempre; a guarda acrescenta
  -- o que só a rota conferia, e a RPC é alcançável direto pelo PostgREST.
  perform public.fn_tags_guarda(p_org, 'manager');

  if p_acao is null or p_acao not in ('renomear', 'juntar', 'excluir', 'definir_cor') then
    raise exception using errcode = '22023', message = 'acao_invalida';
  end if;
  if v_tag = '' then
    raise exception using errcode = '22023', message = 'tag_obrigatoria';
  end if;
  v_remover := (p_acao = 'excluir');
  v_so_cor  := (p_acao = 'definir_cor');
  if not v_remover and not v_so_cor and v_destino = '' then
    raise exception using errcode = '22023', message = 'destino_obrigatorio';
  end if;
  -- `v_cor` vazio é pedido legítimo ("sem cor"): limpa. O que não passa é cor
  -- malformada — gravar `#12` e devolver `#12` para a tela pintar deixaria o
  -- chip sem cor sem ninguém saber por quê.
  if v_so_cor and v_cor <> '' and v_cor !~ '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'cor_invalida';
  end if;

  -- ── POR QUE NÃO SAI EVENTO DAQUI ──────────────────────────────────────────
  --
  -- Os laços abaixo CONTAM as linhas alteradas e não emitem nada em `event_log`.
  -- A primeira versão emitia `contact.tags_changed` / `lead.tags_changed` /
  -- `conversation.tags_changed` POR LINHA, e nenhum desses tipos tem consumidor:
  -- `lib/event-log/register-handlers.ts` registra 13 handlers e nenhum os
  -- declara; o motor de automação ouve `lead.tag_added`/`contact.tag_added`, que
  -- é outro tipo (e disparar automação num renomear em lote seria pior que não
  -- disparar). Evento sem consumidor é o anti-pattern 3 do CLAUDE.md, e aqui
  -- custava milhares de linhas dentro de UMA transação, num log que nada drena e
  -- nada expurga.
  --
  -- Quem registra a operação é o AUDIT LOG, na borda: `tag_vocabulary.changed`
  -- em `app/api/v1/tags/vocabulario/route.ts`, com os contadores que este corpo
  -- devolve. E a tela aberta se atualiza pelo Realtime das próprias tabelas.

  -- ── (z) A COR SAI ANTES DOS LAÇOS, E NÃO É OTIMIZAÇÃO ─────────────────────
  --
  -- Cor é atributo do VOCABULÁRIO, não das linhas: `contacts.tags`,
  -- `crm_leads.tags` e `conversations.tags` continuam `text[]` de nomes, porque
  -- automação, webhook (`lead.tag_added`) e MCP (`*.tags_changed`) falam em
  -- string há versões (contrato da fatia S4). Então a ação `definir_cor` não tem
  -- o que reescrever em contatos, leads nem conversas — e os laços abaixo, se
  -- rodassem, custariam uma varredura das três tabelas para devolver zero.
  --
  -- O bloco das listas de sugestão (mais abaixo) é pior que inútil aqui: ele
  -- troca o nome da semente por `v_destino` e descarta o que sobra vazio — com
  -- `destino` nulo nesta ação, a semente seria APAGADA. Daí o `return` cedo:
  -- nesta ação, só o vocabulário curado muda.
  if v_so_cor then
    -- 9038 (3): trava da curadoria e da linha — ver o cabeçalho da migration.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text, 9005));
    select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o where o.id = p_org
    for no key update;
    if v_settings is null then
      v_settings := '{}'::jsonb;
    end if;

    -- (a) tolera `settings.tags` torto (escalar/objeto): a leitura já tolera com
    -- `jsonb_typeof`, e sem esta guarda o `jsonb_array_elements` levantava
    -- `cannot extract elements from a scalar` e derrubava a tela inteira numa
    -- organização com o dado malformado. Lista que não é lista é lista vazia.
    v_antes := case
      when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
      else '[]'::jsonb
    end;
    v_depois := coalesce(
      (
        select jsonb_agg(entrada.valor order by entrada.ord)
        from (
          -- Uma entrada por chave canônica, agora acrescentando a cor na que
          -- casar. A entrada que era string vira objeto — a mesma forma que o
          -- rename já grava (mais abaixo, `jsonb_build_object('tag', …)`) — e
          -- `descricao` que já existia é PRESERVADA: esta ação fala de cor.
          --
          -- ⚠️ O desempate é o MESMO da função de leitura
          -- (`fn_vocabulario_de_tags`, `order by … (cor is not null or descricao
          -- is not null) desc`), e de propósito: onde a lista curada já tiver a
          -- mesma etiqueta duas vezes (uma como string, outra como objeto com
          -- cor), quem sobrevive é a entrada que carrega o metadado. Ordenar só
          -- por `ord` apagaria a cor na primeira vez que a ação rodasse sobre um
          -- vocabulário nesse estado, e a tela mostraria "sem cor" logo depois de
          -- alguém ter escolhido uma.
          select distinct on (lower(x.chave)) x.valor, x.ord
          from (
            select btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) as chave,
                   case
                     when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then case
                            when nullif(v_cor, '') is null
                            then (case when jsonb_typeof(e.valor) = 'string'
                                       then jsonb_build_object('tag', e.valor #>> '{}')
                                       else e.valor end) - 'cor'
                            else jsonb_set(
                                   case when jsonb_typeof(e.valor) = 'string'
                                        then jsonb_build_object('tag', e.valor #>> '{}')
                                        else e.valor end,
                                   '{cor}', to_jsonb(v_cor))
                          end
                     else case when jsonb_typeof(e.valor) = 'string'
                               then jsonb_build_object('tag', e.valor #>> '{}')
                               else e.valor end
                   end as valor,
                   e.ord
            from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
            where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
          ) x
          where x.valor is not null
          order by lower(x.chave),
                   ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                   x.ord
        ) as entrada
      ),
      '[]'::jsonb
    );

    -- A etiqueta que ainda não tinha entrada no vocabulário curado — semente, ou
    -- nome que só existe em uso (`no_vocabulario = false` na leitura) — GANHA
    -- uma. É deliberado: dar cor é curar. Sem isto, a tela ofereceria cor para
    -- uma etiqueta que continuaria marcada como "em uso, fora do vocabulário", e
    -- a leitura devolveria a cor de uma linha que não está na lista curada.
    if nullif(v_cor, '') is not null and not exists (
      select 1 from jsonb_array_elements(v_depois) as e(valor)
      where lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
    ) then
      v_depois := v_depois || jsonb_build_array(jsonb_build_object('tag', v_tag, 'cor', v_cor));
    end if;

    if v_depois <> v_antes then
      v_settings := jsonb_set(v_settings, '{tags}', v_depois);
      update public.organizations o
         set settings = v_settings,
             updated_at = now()
       where o.id = p_org;
      v_definido := true;
    end if;

    return jsonb_build_object(
      'acao', p_acao,
      'tag', v_tag,
      'destino', null,
      'cor', nullif(v_cor, ''),
      'contatos', 0,
      'leads', 0,
      'conversas', 0,
      'regras', 0,
      'alterou', v_definido
    );
  end if;

  -- 9038 (2): a etiqueta `cliente` de CONTATO, com a regra da agenda ligada, não
  -- é renomeada, juntada (como origem ou destino) nem excluída por aqui. A
  -- reserva é a da 9005 e compara em minúsculas, a régua de `fn_tags_normalizar`.
  --
  -- ⚠️ `array_remove(..., null)`: no excluir não há destino, e `'cliente' = any`
  -- de uma lista com nulo dá NULO, não falso. A reserva leria "talvez seja
  -- cliente" e recusaria a exclusão de QUALQUER etiqueta com a regra ligada.
  perform public.fn_tags_reserva(
    p_org, 'contato', array_remove(array[lower(v_tag), lower(nullif(v_destino, ''))], null)
  );

  -- 9038 (3): a ordem de travas é 262 compartilhada (reserva, só quando envolve
  -- `cliente`) → advisory 9005 (a mesma de criar/arquivar) → linha da
  -- organização → contatos, leads, conversas. `settings` é lido UMA vez, aqui,
  -- antes dos laços. `for no key update` e não `for update`: não bloqueia os
  -- INSERTs com FK para `organizations` (mensagens, event_log) enquanto a
  -- operação termina.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text, 9005));
  select coalesce(o.settings, '{}'::jsonb) into v_settings
  from public.organizations o where o.id = p_org
  for no key update;

  if v_settings is null then
    v_settings := '{}'::jsonb;
  end if;

  -- (a) contatos
  for v_id in
    with alvo as (
      select c.id, public.fn_tags_normalizar(c.tags, v_tag, v_destino_minusculo, v_remover) as novas
      from public.contacts c
      where c.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(c.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.contacts c
         set tags = a.novas
        from alvo a
       where c.id = a.id
         and c.tags is distinct from a.novas
      returning c.id
    )
    select id from mudou
  loop
    v_contatos := v_contatos + 1;
  end loop;

  -- (b) leads
  for v_id in
    with alvo as (
      select l.id, public.fn_tags_normalizar(l.tags, v_tag, v_destino, v_remover) as novas
      from public.crm_leads l
      where l.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(l.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.crm_leads l
         set tags = a.novas
        from alvo a
       where l.id = a.id
         and l.tags is distinct from a.novas
      returning l.id
    )
    select id from mudou
  loop
    v_leads := v_leads + 1;
  end loop;

  -- (c) conversas
  for v_id in
    with alvo as (
      select v.id, public.fn_tags_normalizar(v.tags, v_tag, v_destino_minusculo, v_remover) as novas
      from public.conversations v
      where v.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(v.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.conversations v
         set tags = a.novas
        from alvo a
       where v.id = a.id
         and v.tags is distinct from a.novas
      returning v.id
    )
    select id from mudou
  loop
    v_conversas := v_conversas + 1;
  end loop;

  -- (d) as regras dos agentes — o ponto da issue.
  --
  -- `excluir` NÃO apaga a regra: quem exclui a etiqueta é avisado de quantas
  -- regras a escrevem (o número volta no jsonb e a tela pede confirmação), mas
  -- apagar `add_tag` de um agente em produção é decisão de outra tela. Aqui a
  -- lista da regra só é reescrita quando o nome muda ou quando ele sai.
  --
  -- 9038 (3): `v_settings` já foi lido (e a linha travada) antes dos laços.

  if not v_remover then
    with alvo as (
      select r.id,
             jsonb_agg(
               case
                 when a.valor ->> 'type' = 'add_tag'
                  and jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                 then jsonb_set(
                        a.valor,
                        '{config,tags}',
                        to_jsonb(public.fn_tags_normalizar(
                          array(select jsonb_array_elements_text(a.valor -> 'config' -> 'tags')),
                          v_tag, v_destino, false
                        ))
                      )
                 else a.valor
               end
               order by a.ord
             ) as novas
      from public.automation_rules r
      cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
        with ordinality as a(valor, ord)
      where r.organization_id = p_org
      -- ⚠️ `group by r.id` E SÓ. Agrupar também pelo TIPO da ação devolvia uma
      -- linha por (regra, tipo), cada uma com `novas` = só o subconjunto daquele
      -- tipo; o `update ... from alvo` casava as duas linhas, o Postgres usava
      -- UMA arbitrária, e `is distinct from` é sempre verdadeiro num subconjunto
      -- — então a regra com ações de dois tipos era TRUNCADA a um tipo só, em
      -- toda organização, mesmo que ela nunca tenha citado a etiqueta renomeada.
      -- Medido num Postgres real: regra com `add_tag` + `assign_owner` ficava com
      -- uma ação, e a tela dizia "atualizada em 1 regra(s) de agente".
      group by r.id
    ), mudou as (
      update public.automation_rules r
         set actions = alvo.novas,
             updated_at = now()
        from alvo
       where r.id = alvo.id
         and r.actions is distinct from alvo.novas
      returning r.id
    )
    select count(*) into v_regras from mudou;
  else
    -- Exclusão: conta as regras que ainda escrevem a etiqueta, sem tocar nelas.
    select count(distinct r.id) into v_regras
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as a(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
           then a.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as e(valor)
    where r.organization_id = p_org
      and a.valor ->> 'type' = 'add_tag'
      and lower(btrim(e.valor #>> '{}')) = lower(v_tag);
  end if;

  -- (e) o vocabulário da organização, nos lugares onde ele mora.
  --
  -- 9038 (5): no EXCLUIR, só a entrada da etiqueta excluída vira nula. A 0336
  -- escrevia `when v_remover then null` sem casar o nome, e excluir UMA etiqueta
  -- esvaziava `settings.tags` inteiro (todas as cores) e todas as sugestões de
  -- conversa da organização. Medido no invariante desta migration.
  -- Mesma guarda do ramo de renomear: `settings.tags` malformado não pode
  -- derrubar a cor (a leitura tolera; a escrita agora também).
  v_antes := case
    when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
    else '[]'::jsonb
  end;

  -- ── (e0) O AVISO DE JUNÇÃO — renomear NÃO é renome simples quando o nome
  -- já existe (issue #2801) ────────────────────────────────────────────────
  --
  -- Renomear para um nome que JÁ ESTÁ no vocabulário junta as duas entradas
  -- numa só, e a operação respondia `alterou: true` idêntico a um renome
  -- simples: a tela dizia "Etiqueta atualizada" enquanto duas etiquetas
  -- viravam uma. O marcador é medido AQUI, no vocabulário curado, e não na
  -- tela — a tela só tem a lista que ela mesma acabou de ler, e o caso
  -- justamente interessante é o que já vinha como DUAS linhas.
  --
  -- O alcance é declarado: `juntou` diz "duas ENTRADAS do vocabulário curado
  -- colapsaram". `juntar` um nome que só existia em uso (fora do vocabulário)
  -- não colapsa entrada nenhuma ali, e o marcador fica `false` — o que
  -- normalizou os nomes nesse caso foi `fn_tags_normalizar`, outro desenho.
  if not v_remover then
    select exists (
      select 1
      from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
      where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
      group by lower(
                case when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                     else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                end
              )
      having count(*) > 1
    ) into v_juntou;
  end if;
  v_depois := coalesce(
    (
      select jsonb_agg(entrada.valor order by entrada.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição (mesma razão de
        -- `fn_tags_normalizar`): juntar duas entradas de chaves diferentes num
        -- nome só deixava as duas no vocabulário, agora com o mesmo `tag`.
        --
        -- ⚠️ `cor` e `descricao` da entrada sobrevivem ao rename: o `jsonb_set`
        -- mexe só em `{tag}`. Renomear não é perder a cor que alguém escolheu.
        select distinct on (lower(x.chave)) x.valor, x.ord
        from (
          select case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                   else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                 end as chave,
                 case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then jsonb_set(
                            case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                                 else e.valor end,
                            '{tag}', to_jsonb(v_destino))
                   else case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                             else e.valor end
                 end as valor,
                 e.ord
          from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
          where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
        ) x
        where x.valor is not null and coalesce(x.chave, '') <> ''
        -- ⚠️ O DESEMPATE É PELO METADADO, ANTES DA ORDEM (issue #2801).
        --
        -- Com `order by lower(x.chave), x.ord` a primeira entrada pela posição
        -- ficava, COM OU SEM cor/descrição: renomear "a" (que tinha cor) para
        -- "b" (que existia antes, sem cor) PERDIA a cor que o operador havia
        -- escolhido — a entrada vazia de metadado vinha primeiro na lista.
        -- Este é o MESMO desempate da função de leitura
        -- (`fn_vocabulario_de_tags`) e do ramo `definir_cor`: onde a lista tem
        -- a mesma etiqueta duas vezes, sobrevive a que carrega metadado.
        --
        -- Quando as DUAS já têm metadado, o metadado não decide mais nada e o
        -- desempate volta a ser a ORDEM: fica a que já ocupava a posição no
        -- vocabulário — isto é, o destino. Cor contra cor tem de perder uma, e
        -- a regra escolhida preserva a identidade (nome + posição + cor) de
        -- quem já estava lá, em vez de deixar a posição da lista decidir
        -- qualquer coisa depois de virar empate técnico.
        order by lower(x.chave),
                 ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                 x.ord
      ) as entrada
      where entrada.valor is not null
    ),
    '[]'::jsonb
  );
  if v_depois <> v_antes then
    v_settings := jsonb_set(v_settings, '{tags}', v_depois);
    v_definido := true;
  end if;

  -- 9038 (1): as QUATRO listas de sugestão passam pela substituição que a 0336
  -- fazia só em `canonical_conversation_tags`. Cada uma é `array de text`
  -- (formato da 0244, mantido pela 9005); lista que não é lista é lista vazia,
  -- a mesma tolerância de `settings.tags` acima.
  foreach v_chave in array array[
    'canonical_conversation_tags',
    'archived_conversation_tags',
    'canonical_contact_tags',
    'archived_contact_tags'
  ]
  loop
    v_antes := case
      when jsonb_typeof(v_settings -> v_chave) = 'array' then v_settings -> v_chave
      else '[]'::jsonb
    end;
    v_depois := coalesce(
      (
        select jsonb_agg(semente.valor order by semente.ord)
        from (
          -- Dedupe pela chave DEPOIS da substituição, como acima.
          select distinct on (lower(y.valor)) y.valor, y.ord
          from (
            select case
                     when v_remover and lower(btrim(s.valor #>> '{}')) = lower(v_tag) then null
                     when lower(btrim(s.valor #>> '{}')) = lower(v_tag) then v_destino
                     else btrim(s.valor #>> '{}')
                   end as valor,
                   s.ord
            from jsonb_array_elements(v_antes) with ordinality as s(valor, ord)
            where btrim(s.valor #>> '{}') <> ''
          ) y
          where coalesce(y.valor, '') <> ''
          order by lower(y.valor), y.ord
        ) as semente
        where semente.valor is not null
      ),
      '[]'::jsonb
    );
    -- Só grava a chave que existia ou que mudou: organização que nunca teve a
    -- lista continua sem ela, em vez de ganhar quatro `[]` a cada operação.
    if v_depois <> v_antes and (v_settings ? v_chave or v_depois <> '[]'::jsonb) then
      v_settings := jsonb_set(v_settings, array[v_chave], v_depois);
      v_definido := true;
    end if;
  end loop;

  -- 9038 (1): sugerida vence arquivada no mesmo escopo — ver o cabeçalho.
  foreach v_escopo in array array['conversation', 'contact']
  loop
    v_sugeridas := case
      when jsonb_typeof(v_settings -> ('canonical_' || v_escopo || '_tags')) = 'array'
      then v_settings -> ('canonical_' || v_escopo || '_tags') else '[]'::jsonb
    end;
    v_arquivadas := case
      when jsonb_typeof(v_settings -> ('archived_' || v_escopo || '_tags')) = 'array'
      then v_settings -> ('archived_' || v_escopo || '_tags') else '[]'::jsonb
    end;
    v_depois := coalesce(
      (
        select jsonb_agg(a.valor order by a.ord)
        from jsonb_array_elements(v_arquivadas) with ordinality as a(valor, ord)
        where not exists (
          select 1 from jsonb_array_elements(v_sugeridas) as c(valor)
          where lower(btrim(c.valor #>> '{}')) = lower(btrim(a.valor #>> '{}'))
        )
      ),
      '[]'::jsonb
    );
    if v_depois <> v_arquivadas then
      v_settings := jsonb_set(v_settings, array['archived_' || v_escopo || '_tags'], v_depois);
      v_definido := true;
    end if;
  end loop;

  if v_definido then
    update public.organizations o
       set settings = v_settings,
           updated_at = now()
     where o.id = p_org;
  end if;

  return jsonb_build_object(
    'acao', p_acao,
    'tag', v_tag,
    'destino', nullif(v_destino, ''),
    'cor', null,
    'contatos', v_contatos,
    'leads', v_leads,
    'conversas', v_conversas,
    'regras', v_regras,
    -- `juntou` é o AVISO de que esta operação juntou duas etiquetas do
    -- vocabulário numa só (issue #2801). Sem ele a resposta era indistinguível
    -- de um renome simples, e a tela não tinha o que dizer. `false` no renome
    -- que não juntou, no excluir e em `juntar` cujo destino não estava no
    -- vocabulário curado (ver o bloco (e0)).
    'juntou', v_juntou,
    'alterou', (v_contatos + v_leads + v_conversas + v_regras > 0 or v_definido)
  );
end;
$$;

revoke execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
