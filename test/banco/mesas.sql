-- Teste no banco (Supabase) da quantidade de mesas configurável.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_MESAS_PASSOU.
do $$
declare
  ok boolean; log text := ''; antes int;
begin
  antes := (select table_count from kiosk_settings where id = 1);

  -- 1. aumentar cria as mesas que faltam, ativas
  perform set_table_count(antes + 3);
  if (select table_count from kiosk_settings where id = 1) <> antes + 3 then raise exception 'FALHA table_count não mudou'; end if;
  if (select count(*) from kiosk_tables where number between 1 and antes + 3) <> antes + 3 then raise exception 'FALHA mesas novas não criadas'; end if;
  if exists (select 1 from kiosk_tables where number = antes + 3 and not active) then raise exception 'FALHA mesa nova inativa'; end if;
  log := log || 'aumentar OK; ';

  -- 2. diminuir apaga as que sobraram sem pedido e guarda as que têm pedido
  perform set_table_count(1);
  if exists (select 1 from kiosk_tables t where t.number > 1
               and not exists (select 1 from orders o where o.table_number = t.number)) then
    raise exception 'FALHA mesa sem pedido acima do limite não foi apagada'; end if;
  if exists (select 1 from orders o where not exists (select 1 from kiosk_tables t where t.number = o.table_number)) then
    raise exception 'FALHA pedido ficou sem mesa'; end if;
  log := log || 'diminuir OK; ';

  -- 3. recusa 0 e mais de 500
  ok := false;
  begin perform set_table_count(0); exception when others then ok := sqlerrm like 'invalid_table_count%'; end;
  if not ok then raise exception 'FALHA 0 mesas aceito'; end if;
  ok := false;
  begin update kiosk_settings set table_count = 501 where id = 1; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA 501 mesas aceito'; end if;
  log := log || 'limites OK; ';

  -- 4. cliente e anônimo não chamam a função direto
  if has_function_privilege('anon', 'public.set_table_count(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.set_table_count(integer)', 'execute') then
    raise exception 'FALHA set_table_count liberada para anon/authenticated'; end if;
  log := log || 'permissões OK';

  raise exception 'TESTE_MESAS_PASSOU: %', log;
end $$;
