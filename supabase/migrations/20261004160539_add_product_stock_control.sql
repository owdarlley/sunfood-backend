-- Já aplicada no Supabase em 2026-10-04; versionada aqui como registro.
-- Estoque por produto (RN de controle de estoque). NULL = não controlado
-- (comportamento atual, ilimitado); quando preenchido, decrementa a cada
-- pedido e volta quando o pedido é cancelado.
alter table public.products
  add column stock_qty integer null,
  add constraint products_stock_qty_check check (stock_qty is null or stock_qty >= 0);

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
  insert into public.orders (customer_id, table_number, subtotal, fee, total, note, status, payment_status)
  values (
    (payload->>'customerId')::uuid,
    (payload->>'tableNumber')::int,
    (payload->>'subtotal')::numeric,
    (payload->>'fee')::numeric,
    (payload->>'total')::numeric,
    coalesce(payload->>'note', ''),
    'Na Fila',
    'pending'
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

create or replace function public.set_order_status(p_order_id uuid, p_status text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  current_status text;
  updated public.orders;
begin
  select status into current_status from public.orders where id = p_order_id;
  if current_status is null then
    raise exception 'order_not_found';
  end if;

  if not (
    (current_status = 'Na Fila' and p_status in ('Em Preparo', 'Cancelado')) or
    (current_status = 'Em Preparo' and p_status = 'Pronto') or
    (current_status = 'Pronto' and p_status = 'Entregue')
  ) then
    raise exception 'invalid_transition: % -> %', current_status, p_status;
  end if;

  -- Cancelamento devolve ao estoque os itens reservados por este pedido
  -- (só produtos com estoque controlado, stock_qty não nulo).
  if p_status = 'Cancelado' then
    update public.products p
    set stock_qty = p.stock_qty + oi.qty
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.product_id = p.id
      and p.stock_qty is not null;
  end if;

  update public.orders set status = p_status where id = p_order_id returning * into updated;
  insert into public.order_status_log (order_id, status) values (p_order_id, p_status);
  return to_jsonb(updated);
end;
$function$;
