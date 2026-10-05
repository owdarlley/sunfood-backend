-- Teste no banco (Supabase) dos relatórios do admin (sales_report).
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Compara antes/depois, então funciona mesmo com pedidos reais no banco.
-- Passou = a mensagem começa com TESTE_RELATORIOS_PASSOU.
do $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  meio_dia timestamptz := ((now() at time zone 'America/Sao_Paulo')::date + time '12:00') at time zone 'America/Sao_Paulo';
  antes1 jsonb; antes7 jsonb; antes30 jsonb; r1 jsonb; r7 jsonb; r30 jsonb;
  pid uuid; ok boolean; qtd_x numeric; log text := '';
begin
  antes1 := sales_report(1); antes7 := sales_report(7); antes30 := sales_report(30);

  -- A: PIX aprovado hoje 12h, R$ 50 (3x X a 10 + 1x Y a 20) -> conta
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (1, 50, 0, 50, 'Entregue', 'pix', 'approved', meio_dia) returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_X', 10, 3), (pid, 'TESTE_REL_Y', 20, 1);
  -- B: pagar na entrega hoje 12h, R$ 30 (3x X) -> conta
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (2, 30, 0, 30, 'Pronto', 'entrega', 'pending', meio_dia) returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_X', 10, 3);
  -- C: PIX ainda não pago -> não conta
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (3, 100, 0, 100, 'Na Fila', 'pix', 'pending', meio_dia) returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_X', 10, 10);
  -- D: cancelado -> não conta
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (4, 100, 0, 100, 'Cancelado', 'entrega', 'pending', meio_dia) returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_X', 10, 10);
  -- E: cartão estornado -> não conta
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (5, 100, 0, 100, 'Entregue', 'cartao', 'refunded', meio_dia) returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_X', 10, 10);
  -- F: PIX aprovado há 8 dias, R$ 40 -> só entra nos 30 dias
  insert into orders (table_number, subtotal, fee, total, status, payment_method, payment_status, created_at)
    values (6, 40, 0, 40, 'Entregue', 'pix', 'approved', meio_dia - interval '8 days') returning id into pid;
  insert into order_items (order_id, name, price, qty) values (pid, 'TESTE_REL_Y', 20, 2);

  r1 := sales_report(1); r7 := sales_report(7); r30 := sales_report(30);

  -- 1. vendas: só pago / na entrega, sem cancelado nem estorno
  if (r1->>'revenue')::numeric - (antes1->>'revenue')::numeric <> 80 then
    raise exception 'FALHA faturamento de hoje: esperado +80, veio +%', (r1->>'revenue')::numeric - (antes1->>'revenue')::numeric; end if;
  if (r1->>'orders')::int - (antes1->>'orders')::int <> 2 then raise exception 'FALHA pedidos de hoje'; end if;
  if (r7->>'revenue')::numeric - (antes7->>'revenue')::numeric <> 80 then raise exception 'FALHA faturamento 7 dias'; end if;
  if (r30->>'revenue')::numeric - (antes30->>'revenue')::numeric <> 120 then raise exception 'FALHA faturamento 30 dias'; end if;
  if (r1->>'itemsSold')::numeric - (antes1->>'itemsSold')::numeric <> 7 then raise exception 'FALHA itens vendidos'; end if;
  log := log || 'vendas OK; ';

  -- 2. mais vendidos: X vendeu 6 (A+B), o resto não entra
  select (p->>'qty')::numeric into qtd_x from jsonb_array_elements(r1->'topProducts') p where p->>'name' = 'TESTE_REL_X';
  if qtd_x is distinct from 6 then raise exception 'FALHA mais vendidos: X = %', qtd_x; end if;
  log := log || 'mais vendidos OK; ';

  -- 3. horários de pico: +2 pedidos às 12h, 24 horas, dias certos
  if jsonb_array_length(r1->'byHour') <> 24 then raise exception 'FALHA gráfico por hora sem 24 horas'; end if;
  if (r1->'byHour'->12->>'orders')::int - (antes1->'byHour'->12->>'orders')::int <> 2 then raise exception 'FALHA pico das 12h'; end if;
  if jsonb_array_length(r7->'byDay') <> 7 or jsonb_array_length(r30->'byDay') <> 30 then raise exception 'FALHA dias do período'; end if;
  if (r7->'byDay'->6->>'date')::date <> hoje then raise exception 'FALHA último dia não é hoje'; end if;
  log := log || 'horários de pico OK; ';

  -- 4. período inválido é recusado e só o servidor pode chamar
  ok := false;
  begin perform sales_report(0); exception when others then ok := sqlerrm like 'invalid_period%'; end;
  if not ok then raise exception 'FALHA período 0 aceito'; end if;
  if has_function_privilege('anon', 'public.sales_report(int)', 'execute')
     or has_function_privilege('authenticated', 'public.sales_report(int)', 'execute') then
    raise exception 'FALHA cliente consegue ver o faturamento'; end if;
  log := log || 'segurança OK';

  raise exception 'TESTE_RELATORIOS_PASSOU: %', log;
end $$;
