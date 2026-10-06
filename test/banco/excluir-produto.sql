-- Teste no banco (Supabase) da exclusão de produto. Roda tudo e no fim dá erro
-- DE PROPÓSITO: o Postgres desfaz tudo, nada fica apagado ou arquivado.
-- Passou = a mensagem de erro começa com TESTE_PASSOU.
do $$
declare used uuid; fresh uuid; r jsonb; ok boolean := false; log text := '';
begin
  select product_id into used from order_items limit 1;
  r := delete_or_archive_product(used);
  if r->>'action' <> 'archived' then raise exception 'FALHA usado: %', r; end if;
  if not exists (select 1 from products where id = used and archived_at is not null) then raise exception 'FALHA não arquivou'; end if;
  log := log || 'arquiva com pedido OK; ';
  begin perform delete_or_archive_product(used); exception when others then ok := sqlerrm = 'product_not_found'; end;
  if not ok then raise exception 'FALHA arquivar 2x'; end if;
  insert into products (name, description, category, price, mark) select 'TESTE-EXCLUIR', '', category, 1, mark from products limit 1 returning id into fresh;
  r := delete_or_archive_product(fresh);
  if r->>'action' <> 'deleted' or exists (select 1 from products where id = fresh) then raise exception 'FALHA apagar: %', r; end if;
  log := log || 'apaga sem pedido OK; ';
  raise exception 'TESTE_PASSOU: %', log;
end $$;
