-- Teste de fluxo no banco (Supabase). Roda tudo e no fim dá erro DE PROPÓSITO:
-- o Postgres desfaz tudo, então nenhum pedido/estoque de teste fica gravado.
-- Passou = a mensagem de erro começa com TESTE_FLUXO_PASSOU. Qualquer FALHA = bug.
do $$
declare
  cust uuid; tbl int; prod record; oid uuid; oid2 uuid; s int; n int; ok boolean;
  log text := '';
begin
  select id into cust from profiles where role = 'cliente' limit 1;
  select number into tbl from kiosk_tables where active order by number limit 1;
  select id, name, price into prod from products where not sold_out order by name limit 1;
  update products set stock_qty = 5 where id = prod.id;  -- estoque de teste (desfeito no fim)

  -- 1. pedido baixa o estoque
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price*2, 'fee', 0, 'total', prod.price*2, 'note', 'TESTE-FLUXO',
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 2)))))->>'id';
  select stock_qty into s from products where id = prod.id;
  if s <> 3 then raise exception 'FALHA estoque após pedido: esperado 3, veio %', s; end if;
  log := log || 'pedido baixa estoque OK; ';

  -- 2. cancelar devolve o estoque
  perform set_order_status(oid, 'Cancelado');
  select stock_qty into s from products where id = prod.id;
  if s <> 5 then raise exception 'FALHA estoque após cancelar: esperado 5, veio %', s; end if;
  log := log || 'cancelar devolve estoque OK; ';

  -- 3. cancelar de novo é bloqueado
  ok := false;
  begin perform set_order_status(oid, 'Cancelado'); exception when others then ok := sqlerrm like 'invalid_transition%'; end;
  if not ok then raise exception 'FALHA cancelamento duplo não foi bloqueado'; end if;
  log := log || 'cancelar 2x bloqueado OK; ';

  -- 4. fluxo da cozinha até Entregue
  oid2 := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price,
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1)))))->>'id';
  perform set_order_status(oid2, 'Em Preparo');
  perform set_order_status(oid2, 'Pronto');
  perform set_order_status(oid2, 'Entregue');
  select count(*) into n from order_status_log where order_id = oid2;
  if n <> 4 then raise exception 'FALHA histórico de status: esperado 4, veio %', n; end if;
  log := log || 'fila>preparo>pronto>entregue OK; ';

  -- 5. pular etapa é bloqueado
  ok := false;
  begin perform set_order_status(oid2, 'Na Fila'); exception when others then ok := sqlerrm like 'invalid_transition%'; end;
  if not ok then raise exception 'FALHA transição inválida aceita'; end if;
  log := log || 'transição inválida bloqueada OK; ';

  -- 6. sem estoque suficiente é bloqueado
  ok := false;
  begin perform create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', 0, 'fee', 0, 'total', 0,
    'items', jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 99))));
  exception when others then ok := sqlerrm like 'out_of_stock%'; end;
  if not ok then raise exception 'FALHA venda acima do estoque aceita'; end if;
  log := log || 'acima do estoque bloqueado OK';

  -- Sempre termina com erro de propósito: o Postgres desfaz TUDO (nada fica no banco).
  raise exception 'TESTE_FLUXO_PASSOU: %', log;
end $$;
