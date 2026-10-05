-- CPF no cadastro do cliente. Só os 11 dígitos, com os dígitos verificadores
-- conferidos aqui também (não só na API), e um CPF por conta. Fica vazio
-- nas contas antigas e da equipe: o cliente preenche na tela "Falta pouco"
-- antes do próximo pedido.
create or replace function public.is_valid_cpf(cpf text)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  len int;
  i int;
  total int;
  digit int;
begin
  if cpf is null or cpf !~ '^[0-9]{11}$' or cpf ~ '^(.)\1{10}$' then
    return false;
  end if;
  foreach len in array array[9, 10] loop
    total := 0;
    for i in 1..len loop
      total := total + substr(cpf, i, 1)::int * (len + 2 - i);
    end loop;
    digit := (total * 10 % 11) % 10;
    if digit <> substr(cpf, len + 1, 1)::int then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

alter table public.profiles add column if not exists cpf text;
alter table public.profiles
  add constraint profiles_cpf_valid check (cpf is null or public.is_valid_cpf(cpf));
create unique index if not exists profiles_cpf_key on public.profiles (cpf) where cpf is not null;

-- O cadastro por e-mail manda o CPF junto com nome/telefone (metadata do
-- Supabase Auth). Inclui também o nome do Google (full_name).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, name, phone, cpf, birth_date, terms_accepted_at)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'name', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'phone',
    nullif(new.raw_user_meta_data->>'cpf', ''),
    nullif(new.raw_user_meta_data->>'birth_date', '')::date,
    nullif(new.raw_user_meta_data->>'terms_accepted_at', '')::timestamptz
  );
  return new;
end;
$function$;
