-- Corrige a devolução de estoque no cancelamento:
-- 1. Trava o pedido (FOR UPDATE) antes de validar a transição: dois
--    cancelamentos simultâneos liam 'Na Fila' ao mesmo tempo e devolviam o
--    estoque duas vezes. Agora o segundo espera o primeiro e cai em
--    invalid_transition (Cancelado -> Cancelado).
-- 2. Soma as quantidades por produto: o mesmo produto em duas linhas do
--    pedido (ex.: observações diferentes) só devolvia uma delas, porque
--    UPDATE ... FROM aplica uma única linha do join por produto.
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

  update public.orders set status = p_status where id = p_order_id returning * into updated;
  insert into public.order_status_log (order_id, status) values (p_order_id, p_status);
  return to_jsonb(updated);
end;
$function$;
