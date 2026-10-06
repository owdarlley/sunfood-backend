-- Quantidade de mesas configurável pelo admin. O cliente digita o número da
-- mesa (plaquinha do guarda-sol); agora só vale de 1 até table_count.
-- Padrão 12, que é quantas mesas o quiosque já tinha.
alter table public.kiosk_settings
  add column table_count integer not null default 12,
  add constraint kiosk_settings_table_count_check check (table_count between 1 and 500);

-- Muda a quantidade e deixa kiosk_tables batendo com ela: cria as mesas que
-- faltam (ativas, 4 lugares) e apaga as que sobraram. Mesa que já teve pedido
-- não pode ser apagada (o histórico aponta pra ela), então fica guardada, mas
-- fora da faixa 1..table_count ela não aparece nem aceita pedido.
create or replace function public.set_table_count(p_count integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'invalid_table_count';
  end if;

  update kiosk_settings set table_count = p_count where id = 1;

  insert into kiosk_tables (number)
  select n from generate_series(1, p_count) n
  on conflict (number) do nothing;

  delete from kiosk_tables t
   where t.number > p_count
     and not exists (select 1 from orders o where o.table_number = t.number);

  return p_count;
end;
$$;

revoke all on function public.set_table_count(integer) from public, anon, authenticated;
grant execute on function public.set_table_count(integer) to service_role;
