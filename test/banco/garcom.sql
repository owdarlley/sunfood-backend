-- Teste do perfil Garçom no banco (Supabase). Roda tudo e no fim dá erro DE
-- PROPÓSITO: o Postgres desfaz tudo, então nenhum pedido de teste fica gravado.
-- Passou = a mensagem de erro começa com TESTE_GARCOM_PASSOU. Qualquer FALHA = bug.
do $$
declare
  waiter uuid; tbl int; prod record; oid uuid; oid2 uuid; m jsonb; r record;
  log text := '';
begin
  -- Qualquer conta da equipe serve de "garçom" aqui: a função de métricas não
  -- olha o papel, só quem lançou/entregou.
  select id into waiter from profiles where role <> 'cliente' order by role limit 1;
  select number into tbl from kiosk_tables where active order by number limit 1;
  select id, name, price into prod from products where not sold_out and archived_at is null order by name limit 1;
  update products set stock_qty = null where id = prod.id;  -- sem estoque controlado (desfeito no fim)

  -- 1. papel "garcom" é aceito
  update profiles set role = 'garcom' where id = waiter;
  log := log || 'papel garcom aceito OK; ';

  -- 2. pedido lançado pelo garçom: sem cliente, com waiter_id
  oid := (create_order(jsonb_build_object('waiterId', waiter, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'entrega',
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1)))))->>'id';
  select customer_id, waiter_id, payment_method into r from orders where id = oid;
  if r.customer_id is not null or r.waiter_id is distinct from waiter or r.payment_method <> 'entrega' then
    raise exception 'FALHA pedido do garçom: cliente %, garçom %, pagamento %', r.customer_id, r.waiter_id, r.payment_method;
  end if;
  log := log || 'pedido lançado pelo garçom OK; ';

  -- 3. "Entregue" grava quem entregou e quando
  perform set_order_status(oid, 'Em Preparo');
  perform set_order_status(oid, 'Pronto');
  perform set_order_status(oid, 'Entregue', waiter);
  select delivered_by, delivered_at into r from orders where id = oid;
  if r.delivered_by is distinct from waiter or r.delivered_at is null then
    raise exception 'FALHA entregue sem registrar o garçom: %, %', r.delivered_by, r.delivered_at;
  end if;
  log := log || 'entregue grava garçom OK; ';

  -- 4. chamada antiga (sem p_actor) continua funcionando
  oid2 := (create_order(jsonb_build_object('tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'entrega',
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1)))))->>'id';
  perform set_order_status(oid2, 'Em Preparo');
  log := log || 'chamada sem garçom OK; ';

  -- 5. métricas de hoje
  m := waiter_metrics(waiter, 1);
  if (m->>'delivered')::int < 1 then raise exception 'FALHA métricas: entregues %', m->>'delivered'; end if;
  if (m->>'launched')::int < 1 then raise exception 'FALHA métricas: lançados %', m->>'launched'; end if;
  if (m->>'launchedTotal')::numeric < prod.price then raise exception 'FALHA métricas: valor %', m->>'launchedTotal'; end if;
  if jsonb_array_length(m->'byDay') <> 1 then raise exception 'FALHA métricas: dias %', m->'byDay'; end if;
  m := waiter_metrics(waiter, 7);
  if jsonb_array_length(m->'byDay') <> 7 then raise exception 'FALHA métricas 7 dias: %', jsonb_array_length(m->'byDay'); end if;
  log := log || 'métricas OK; ';

  -- 6. período inválido é recusado
  begin
    perform waiter_metrics(waiter, 0);
    raise exception 'FALHA período 0 aceito';
  exception when others then
    if sqlerrm not like 'invalid_period%' then raise; end if;
  end;
  log := log || 'período inválido bloqueado OK';

  -- Sempre termina com erro de propósito: o Postgres desfaz TUDO (nada fica no banco).
  raise exception 'TESTE_GARCOM_PASSOU: %', log;
end $$;
