-- manifest: 9224 — exceção por organização (organizations.aviso_para_conexao_propria, desligada) para o aviso de caso/agendamento ir a uma conexão ativa da própria org, nunca a remetente; a ingestão ignora o que chega de conexão da própria org quando ligada. Idempotente, nada destrutivo.

alter table public.organizations
  add column if not exists aviso_para_conexao_propria boolean not null default false;
comment on column public.organizations.aviso_para_conexao_propria is
  'Exceção da plataforma: o aviso no WhatsApp pode ir para uma conexão ativa da própria org (nunca a remetente). Com ela ligada, o que chega de uma conexão da própria org é ignorado na ingestão. Só platform admin (orgs_update_platform_admin) ou service role escrevem.';

create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_resposta_whatsapp_habilitada boolean default false
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
          -- 9224: com a exceção da organização ligada, só a PRÓPRIA conexão remetente
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

  select * into v_antes from public.config_aviso_de_caso where organization_id = p_org;

  insert into public.config_aviso_de_caso
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, resposta_whatsapp_habilitada, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), coalesce(p_resposta_whatsapp_habilitada, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
        resposta_whatsapp_habilitada = excluded.resposta_whatsapp_habilitada,
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
    'antes_ligado',  coalesce(v_antes.ligado, false)
  );
end;
$$;
revoke all on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean) to authenticated;

create or replace function public.fn_definir_aviso_de_agendamento(
  p_org uuid,
  p_usa_numero_do_aviso_de_caso boolean,
  p_channel uuid,
  p_telefone text,
  p_ligado boolean,
  p_confirma_contato boolean default false
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
            -- 9224: com a exceção da organização ligada, só a PRÓPRIA conexão remetente
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

  select * into v_antes from public.config_aviso_de_agendamento where organization_id = p_org;

  insert into public.config_aviso_de_agendamento
    (organization_id, usa_numero_do_aviso_de_caso, channel_session_id, telefone_destino, ligado, criado_por, atualizado_por)
  values
    (p_org, v_usa, v_channel, v_telefone, coalesce(p_ligado, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set usa_numero_do_aviso_de_caso = excluded.usa_numero_do_aviso_de_caso,
        channel_session_id          = excluded.channel_session_id,
        telefone_destino            = excluded.telefone_destino,
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
-- AS DUAS ORIGENS DE EXECUTE (item 9 da doutrina de migrations).
revoke all     on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean) from public, anon;
grant  execute on function public.fn_definir_aviso_de_agendamento(uuid,boolean,uuid,text,boolean,boolean) to authenticated;
notify pgrst, 'reload schema';
