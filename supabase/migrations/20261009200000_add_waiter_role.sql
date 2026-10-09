-- Perfil Garçom: um papel novo ("garcom") que entrega os pedidos prontos,
-- lança pedido feito na mesa (cliente sem o app) e acompanha as próprias
-- métricas. O admin cria a conta do garçom pela API (service role).
--
-- O garçom NÃO entra em is_staff(): as policies de escrita direta em
-- products, kiosk_settings e kiosk_tables continuam só para admin/cozinha.
-- Tudo o que o garçom faz passa pela API, que confere o papel.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('cliente', 'admin', 'cozinha', 'garcom'));

-- waiter_id: quem lançou o pedido na mesa (null = pedido feito pelo app).
-- delivered_by/delivered_at: quem marcou "Entregue" e quando.
alter table public.orders
  add column if not exists waiter_id uuid references public.profiles(id) on delete set null,
  add column if not exists delivered_by uuid references public.profiles(id) on delete set null,
  add column if not exists delivered_at timestamptz;

create index if not exists orders_waiter_id_idx on public.orders (waiter_id) where waiter_id is not null;
create index if not exists orders_delivered_by_idx on public.orders (delivered_by) where delivered_by is not null;

-- create_order: mesma função, agora grava waiterId quando vier no payload.
-- customerId pode vir nulo (pedido lançado pelo garçom).
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
  insert into public.orders (customer_id, waiter_id, table_number, subtotal, fee, total, note, status, payment_status, payment_method)
  values (
    nullif(payload->>'customerId', '')::uuid,
    nullif(payload->>'waiterId', '')::uuid,
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

-- set_order_status ganha p_actor (opcional): ao marcar "Entregue", grava quem
-- entregou e a hora. Com valor padrão, a API antiga (que chama só com
-- p_order_id e p_status) continua funcionando durante a publicação.
drop function if exists public.set_order_status(uuid, text);
create or replace function public.set_order_status(p_order_id uuid, p_status text, p_actor uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  current_status text;
  updated public.orders;
begin
  select status into current_status from public.orders where id = p_order_id for update;
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
    from (
      select product_id, sum(qty)::int as qty
      from public.order_items
      where order_id = p_order_id
      group by product_id
    ) oi
    where oi.product_id = p.id
      and p.stock_qty is not null;
  end if;

  update public.orders
  set status = p_status,
      delivered_by = case when p_status = 'Entregue' then p_actor else delivered_by end,
      delivered_at = case when p_status = 'Entregue' then now() else delivered_at end
  where id = p_order_id
  returning * into updated;
  insert into public.order_status_log (order_id, status) values (p_order_id, p_status);
  return to_jsonb(updated);
end;
$function$;

revoke execute on function public.set_order_status(uuid, text, uuid) from public, anon, authenticated;

-- Métricas de um garçom no período (hoje, 7 ou 30 dias, horário de São
-- Paulo, igual ao sales_report):
--   delivered      pedidos que ele marcou como entregues
--   avgDeliverMin  tempo médio entre "Pronto" e "Entregue" desses pedidos
--   launched       pedidos que ele lançou na mesa (sem os cancelados)
--   launchedTotal  valor desses pedidos
--   received       quanto ele anotou como recebido nos pedidos "na entrega"
--                  que entregou ou lançou
--   byDay          entregues e lançados por dia
create or replace function public.waiter_metrics(p_waiter uuid, p_days int)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  first_day date;
  result jsonb;
begin
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'invalid_period';
  end if;
  first_day := today - (p_days - 1);

  with delivered as (
    select o.id, o.total, o.delivered_at,
      (select max(l.changed_at) from order_status_log l where l.order_id = o.id and l.status = 'Pronto') as ready_at
    from orders o
    where o.delivered_by = p_waiter
      and (o.delivered_at at time zone 'America/Sao_Paulo')::date between first_day and today
  ),
  launched as (
    select o.id, o.total, o.created_at
    from orders o
    where o.waiter_id = p_waiter
      and o.status <> 'Cancelado'
      and (o.created_at at time zone 'America/Sao_Paulo')::date between first_day and today
  ),
  received as (
    select o.total
    from orders o
    where (o.delivered_by = p_waiter or o.waiter_id = p_waiter)
      and o.payment_method = 'entrega'
      and o.received_with is not null
      and o.status <> 'Cancelado'
      and (o.received_at at time zone 'America/Sao_Paulo')::date between first_day and today
  )
  select jsonb_build_object(
    'days', p_days,
    'from', first_day,
    'to', today,
    'delivered', (select count(*) from delivered),
    'avgDeliverMin', coalesce((
      select round(avg(extract(epoch from (delivered_at - ready_at)) / 60)::numeric, 1)
      from delivered where ready_at is not null and delivered_at >= ready_at
    ), 0),
    'launched', (select count(*) from launched),
    'launchedTotal', coalesce((select sum(total) from launched), 0),
    'received', coalesce((select sum(total) from received), 0),
    'byDay', (
      select jsonb_agg(jsonb_build_object(
        'date', d::date,
        'delivered', (select count(*) from delivered where (delivered_at at time zone 'America/Sao_Paulo')::date = d::date),
        'launched', (select count(*) from launched where (created_at at time zone 'America/Sao_Paulo')::date = d::date)
      ) order by d)
      from generate_series(first_day, today, interval '1 day') as d
    )
  ) into result;
  return result;
end;
$function$;

-- Só o servidor (service role) chama.
revoke execute on function public.waiter_metrics(uuid, int) from public, anon, authenticated;
