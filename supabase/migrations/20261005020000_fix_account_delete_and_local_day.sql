-- 1) "Excluir minha conta" falhava para quem já tinha feito pedido: apagar o
--    usuário apaga o profile (cascade), mas orders.customer_id apontava para
--    profiles sem ON DELETE, então o banco recusava a exclusão inteira.
--    Agora o pedido fica no histórico de vendas do quiosque, só sem dono
--    (anonimizado), o que atende a LGPD e não mexe no faturamento.
alter table public.orders alter column customer_id drop not null;
alter table public.orders drop constraint orders_customer_id_fkey;
alter table public.orders
  add constraint orders_customer_id_fkey
  foreign key (customer_id) references public.profiles(id) on delete set null;

-- 2) O banco roda em UTC, então "hoje" no dashboard, nas métricas e no
--    relatório de encerramento virava o dia às 21h de Brasília, e o gráfico
--    por hora ficava 3h adiantado. Tudo passa a usar o horário de São Paulo.
create or replace function public.dashboard_stats()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with today_orders as (
    select * from orders
    where (created_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
      and status <> 'Cancelado'
  ),
  agg as (
    select coalesce(sum(total),0) as revenue, count(*) as orders_count from today_orders
  ),
  top as (
    select oi.name, sum(oi.qty) as qty
    from order_items oi
    join today_orders o on o.id = oi.order_id
    group by oi.name
    order by sum(oi.qty) desc
    limit 5
  ),
  hourly as (
    select extract(hour from created_at at time zone 'America/Sao_Paulo')::int as hour, coalesce(sum(total),0) as revenue
    from today_orders
    group by 1
  )
  select jsonb_build_object(
    'revenueToday', (select revenue from agg),
    'ordersToday', (select orders_count from agg),
    'avgTicket', case when (select orders_count from agg) > 0
      then round((select revenue from agg) / (select orders_count from agg), 2) else 0 end,
    'topProducts', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty)) from top), '[]'::jsonb),
    'salesByHour', (
      select jsonb_agg(jsonb_build_object('hour', h, 'revenue', coalesce(hourly.revenue,0)) order by h)
      from generate_series(0,23) as h
      left join hourly on hourly.hour = h
    )
  );
$function$;

create or replace function public.ops_metrics()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  result jsonb;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  with logs as (
    select osl.order_id, osl.status, osl.changed_at
    from order_status_log osl
    join orders o on o.id = osl.order_id
    where (o.created_at at time zone 'America/Sao_Paulo')::date = today
  ),
  per_order as (
    select order_id,
      max(changed_at) filter (where status = 'Na Fila') as na_fila_at,
      max(changed_at) filter (where status = 'Em Preparo') as em_preparo_at,
      max(changed_at) filter (where status = 'Pronto') as pronto_at
    from logs
    group by order_id
  ),
  durations as (
    select
      extract(epoch from (em_preparo_at - na_fila_at)) as queue_seconds,
      extract(epoch from (pronto_at - em_preparo_at)) as prep_seconds
    from per_order
  ),
  open_orders as (
    select id, updated_at from orders where status in ('Na Fila','Em Preparo')
  )
  select jsonb_build_object(
    'avgQueueSeconds', (select round(avg(queue_seconds)) from durations where queue_seconds is not null),
    'avgPrepSeconds', (select round(avg(prep_seconds)) from durations where prep_seconds is not null),
    'ordersInQueueOrPrep', (select count(*) from open_orders),
    'lateOrders', (select count(*) from open_orders where extract(epoch from (now() - updated_at)) > 600),
    'cancelledToday', (select count(*) from orders where (created_at at time zone 'America/Sao_Paulo')::date = today and status = 'Cancelado'),
    'soldOutProducts', coalesce((select jsonb_agg(name) from products where sold_out), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;
