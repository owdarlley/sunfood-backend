-- Teste no banco (Supabase) de excluir conta, pedido mínimo, painel e fim do dia.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado
-- (nem o relatório do dia, nem o "dia encerrado").
-- Passou = a mensagem começa com TESTE_CONTA_PASSOU.
do $$
declare
  ok boolean; rep jsonb; st jsonb; log text := ''; n text;
begin
  -- 1. excluir conta: o pedido de quem apagou a conta fica no histórico, sem dono
  select is_nullable into n from information_schema.columns
   where table_schema = 'public' and table_name = 'orders' and column_name = 'customer_id';
  if n <> 'YES' then raise exception 'FALHA orders.customer_id não aceita vazio'; end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_customer_id_fkey' and confdeltype = 'n') then
    raise exception 'FALHA apagar a conta não deixa o pedido sem dono (falta ON DELETE SET NULL)'; end if;
  log := log || 'excluir conta: pedido fica sem dono OK; ';

  -- 2. pedido mínimo: aceita 0 e 2500, recusa negativo
  update kiosk_settings set day_closed = false, paused = false where id = 1;
  update kiosk_settings set min_order_cents = 0 where id = 1;
  update kiosk_settings set min_order_cents = 2500 where id = 1;
  ok := false;
  begin update kiosk_settings set min_order_cents = -1 where id = 1; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA pedido mínimo negativo aceito'; end if;
  log := log || 'pedido mínimo OK; ';

  -- 3. painel e métricas rodam (horário de São Paulo)
  st := dashboard_stats();
  if jsonb_array_length(st->'salesByHour') <> 24 then raise exception 'FALHA gráfico por hora sem 24 horas'; end if;
  perform ops_metrics();
  log := log || 'painel e métricas OK; ';

  -- 4. encerrar o dia gera relatório, marca o quiosque e não deixa encerrar 2x
  rep := close_day();
  if rep->>'id' is null then raise exception 'FALHA relatório do dia não criado'; end if;
  if not (select day_closed from kiosk_settings where id = 1) then raise exception 'FALHA dia não ficou encerrado'; end if;
  ok := false;
  begin perform close_day(); exception when others then ok := sqlerrm like 'day_already_closed%'; end;
  if not ok then raise exception 'FALHA encerrar o dia 2x foi aceito'; end if;
  log := log || 'encerrar o dia OK';

  raise exception 'TESTE_CONTA_PASSOU: %', log;
end $$;
