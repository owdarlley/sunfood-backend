-- Excluir item do cardápio. Produto que já apareceu em pedido não pode sumir
-- do banco (order_items aponta pra ele), então fica "arquivado": some do
-- cardápio e do admin, mas o histórico e os relatórios continuam certos.
alter table public.products
  add column if not exists archived_at timestamptz;

-- Tenta apagar de verdade; se algum pedido usa o produto (a chave estrangeira
-- recusa), arquiva. Tudo numa transação, então um pedido feito no mesmo
-- instante nunca fica apontando pra um produto apagado.
-- Arquivar também tira o "esgotado", pra ele não aparecer nos alertas da cozinha.
create or replace function public.delete_or_archive_product(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  img text;
begin
  delete from products where id = p_id and archived_at is null returning image_url into img;
  if not found then raise exception 'product_not_found'; end if;
  return jsonb_build_object('action', 'deleted', 'imageUrl', img);
exception when foreign_key_violation then
  update products set archived_at = now(), sold_out = false
   where id = p_id and archived_at is null
  returning image_url into img;
  if not found then raise exception 'product_not_found'; end if;
  return jsonb_build_object('action', 'archived', 'imageUrl', img);
end;
$$;

revoke all on function public.delete_or_archive_product(uuid) from public, anon, authenticated;
grant execute on function public.delete_or_archive_product(uuid) to service_role;
