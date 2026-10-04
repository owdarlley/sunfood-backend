-- Forma de pagamento escolhida pelo cliente em cada pedido:
--   pix     -> pago no app (Mercado Pago), só vai pra cozinha depois de pago
--   cartao  -> pago no app (checkout do Mercado Pago), idem
--   entrega -> pago ao garçom na entrega (maquininha ou dinheiro)
-- Pedidos antigos ficam como 'pix', que era a única forma real até aqui.
alter table public.orders
  add column payment_method text not null default 'pix',
  add constraint orders_payment_method_check check (payment_method in ('pix', 'cartao', 'entrega'));

create or replace function public.create_order(payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  new_order public.orders;
  item jsonb;
  item_qty int;
  prod_id uuid;
  current_stock int;
begin
  insert into public.orders (customer_id, table_number, subtotal, fee, total, note, status, payment_status, payment_method)
  values (
    (payload->>'customerId')::uuid,
    (payload->>'tableNumber')::int,
    (payload->>'subtotal')::numeric,
    (payload->>'fee')::numeric,
    (payload->>'total')::numeric,
    coalesce(payload->>'note', ''),
    'Na Fila',
    'pending',
    coalesce(payload->>'paymentMethod', 'pix')
  )
  returning * into new_order;

  for item in select * from jsonb_array_elements(payload->'items')
  loop
    item_qty := (item->>'qty')::int;
    prod_id := (item->>'productId')::uuid;

    -- Trava a linha do produto (FOR UPDATE) pra duas compras concorrentes não
    -- lerem o mesmo saldo e venderem além do estoque (condição de corrida).
    select stock_qty into current_stock from public.products where id = prod_id for update;
    if current_stock is not null then
      if current_stock < item_qty then
        raise exception 'out_of_stock:%', item->>'name';
      end if;
      update public.products set stock_qty = stock_qty - item_qty where id = prod_id;
    end if;

    insert into public.order_items (order_id, product_id, name, price, qty, note)
    values (
      new_order.id,
      prod_id,
      item->>'name',
      (item->>'price')::numeric,
      item_qty,
      coalesce(item->>'note','')
    );
  end loop;

  insert into public.order_status_log (order_id, status) values (new_order.id, 'Na Fila');

  return jsonb_build_object('id', new_order.id);
end;
$function$;
