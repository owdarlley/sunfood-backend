-- Teste no banco (Supabase) das formas de pagamento e do prazo de cancelamento.
-- Termina com erro DE PROPÓSITO: o Postgres desfaz tudo, nada fica gravado.
-- Passou = a mensagem começa com TESTE_PAGAMENTOS_PASSOU.
do $$
declare
  cust uuid; tbl int; prod record; oid uuid; m text; w int; ok boolean;
  log text := '';
  itens jsonb;
begin
  select id into cust from profiles where role = 'cliente' limit 1;
  select number into tbl from kiosk_tables where active order by number limit 1;
  select id, name, price into prod from products where not sold_out order by name limit 1;
  itens := jsonb_build_array(jsonb_build_object('productId', prod.id, 'name', prod.name, 'price', prod.price, 'qty', 1));

  -- 1. sem forma de pagamento informada = PIX (compatível com o app antigo)
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'items', itens)))->>'id';
  select payment_method into m from orders where id = oid;
  if m <> 'pix' then raise exception 'FALHA padrão: esperado pix, veio %', m; end if;
  log := log || 'padrão pix OK; ';

  -- 2. pagar na entrega e cartão são gravados
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'entrega', 'items', itens)))->>'id';
  select payment_method into m from orders where id = oid;
  if m <> 'entrega' then raise exception 'FALHA entrega: veio %', m; end if;
  oid := (create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'cartao', 'items', itens)))->>'id';
  select payment_method into m from orders where id = oid;
  if m <> 'cartao' then raise exception 'FALHA cartao: veio %', m; end if;
  log := log || 'entrega e cartão gravados OK; ';

  -- 3. forma inválida é recusada pelo banco
  ok := false;
  begin perform create_order(jsonb_build_object('customerId', cust, 'tableNumber', tbl,
    'subtotal', prod.price, 'fee', 0, 'total', prod.price, 'paymentMethod', 'fiado', 'items', itens));
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA forma inválida aceita'; end if;
  log := log || 'forma inválida recusada OK; ';

  -- 4. pedido pago pode ser marcado como estornado
  update orders set payment_status = 'approved', payment_id = 'teste' where id = oid;
  perform set_order_status(oid, 'Cancelado');
  update orders set payment_status = 'refunded' where id = oid;
  log := log || 'cancelar + estornado OK; ';

  -- 5. prazo de cancelamento: padrão 0, aceita 5, recusa 121 e negativo
  select cancel_window_minutes into w from kiosk_settings where id = 1;
  if w <> 0 then raise exception 'FALHA prazo padrão: esperado 0, veio %', w; end if;
  update kiosk_settings set cancel_window_minutes = 5 where id = 1;
  ok := false;
  begin update kiosk_settings set cancel_window_minutes = 121 where id = 1; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA prazo 121 aceito'; end if;
  ok := false;
  begin update kiosk_settings set cancel_window_minutes = -1 where id = 1; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA prazo negativo aceito'; end if;
  log := log || 'prazo de cancelamento OK';

  raise exception 'TESTE_PAGAMENTOS_PASSOU: %', log;
end $$;
