-- manifest: 9102 — a importação do histórico ganha uma segunda FONTE (Izzy CRM, migração do cliente Dans Imports). `importacoes_de_historico.fonte` (text, default 'waha', SEM CHECK: o vocabulário vive no TS, doutrina da 0127) e `credencial_cifrada` (token da API do Izzy cifrado por `fn_encrypt_oauth`; a rodada o zera ao concluir ou errar e a rota ao cancelar). Aditiva e idempotente; linha antiga fica 'waha'.
--
-- A tabela só tem leitura para membro da org (policy da 0761): a coluna do token NÃO pode ir a `authenticated`.
-- O select por coluna abaixo tira o grant de tabela inteira e devolve tudo MENOS `credencial_cifrada`.
-- Reverter: alter table public.importacoes_de_historico drop column if exists credencial_cifrada;
--           alter table public.importacoes_de_historico drop column if exists fonte;
--           grant select on public.importacoes_de_historico to authenticated;

alter table public.importacoes_de_historico add column if not exists fonte text not null default 'waha';
alter table public.importacoes_de_historico add column if not exists credencial_cifrada text;

do $grants_importacoes$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'importacoes_de_historico' and column_name <> 'credencial_cifrada';
  revoke select on public.importacoes_de_historico from authenticated;
  execute format('grant select (%s) on public.importacoes_de_historico to authenticated', cols);
end $grants_importacoes$;

notify pgrst, 'reload schema';
