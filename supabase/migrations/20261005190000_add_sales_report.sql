-- Relatórios do admin: vendas, mais vendidos e horários de pico num período
-- (hoje, últimos 7 dias ou últimos 30 dias), no horário de São Paulo, igual ao
-- dashboard_stats.
--
-- Só conta venda de verdade: pedido não cancelado, sem estorno, e pago
-- (PIX/cartão aprovados) ou "pagar na entrega" (o garçom recebe na mesa).
-- PIX/cartão que ficaram esperando pagamento não entram.
create or replace function public.sales_report(p_days int)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  result jsonb;
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  first_day date;
begin
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'invalid_period';
  end if;
  first_day := today - (p_days - 1);

  with sales as (
    select o.*, (o.created_at at time zone 'America/Sao_Paulo') as local_at
    from orders o
    where (o.created_at at time zone 'America/Sao_Paulo')::date between first_day and today
      and o.status <> 'Cancelado'
      and o.payment_status not in ('refunded', 'cancelled')
      and (o.payment_status = 'approved' or o.payment_method = 'entrega')
  ),
  agg as (
    select coalesce(sum(total), 0) as revenue, count(*) as orders_count from sales
  ),
  items as (
    select oi.name, sum(oi.qty) as qty, sum(oi.qty * oi.price) as revenue
    from order_items oi
    join sales s on s.id = oi.order_id
    group by oi.name
  ),
  hourly as (
    select extract(hour from local_at)::int as hour, count(*) as orders_count, sum(total) as revenue
    from sales
    group by 1
  ),
  daily as (
    select local_at::date as day, count(*) as orders_count, sum(total) as revenue
    from sales
    group by 1
  )
  select jsonb_build_object(
    'days', p_days,
    'from', first_day,
    'to', today,
    'revenue', (select revenue from agg),
    'orders', (select orders_count from agg),
    'avgTicket', case when (select orders_count from agg) > 0
      then round((select revenue from agg) / (select orders_count from agg), 2) else 0 end,
    'itemsSold', coalesce((select sum(qty) from items), 0),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'revenue', revenue) order by qty desc, revenue desc, name)
      from (select * from items order by qty desc, revenue desc, name limit 10) t
    ), '[]'::jsonb),
    'byHour', (
      select jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(hourly.orders_count, 0), 'revenue', coalesce(hourly.revenue, 0)) order by h)
      from generate_series(0, 23) as h
      left join hourly on hourly.hour = h
    ),
    'byDay', (
      select jsonb_agg(jsonb_build_object('date', d::date, 'orders', coalesce(daily.orders_count, 0), 'revenue', coalesce(daily.revenue, 0)) order by d)
      from generate_series(first_day, today, interval '1 day') as d
      left join daily on daily.day = d::date
    )
  ) into result;
  return result;
end;
$function$;

-- Só o servidor (service role) chama; cliente logado ou anônimo não vê faturamento.
revoke execute on function public.sales_report(int) from public, anon, authenticated;
