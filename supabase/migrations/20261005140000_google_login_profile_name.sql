-- Login com Google: o Google manda o nome em full_name (e às vezes em name);
-- o cadastro por e-mail manda em name. Sem isso, quem entra pelo Google
-- ficava com nome vazio. Telefone, nascimento e termos ficam nulos até o
-- cliente completar o cadastro (POST /auth/complete-profile).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, name, phone, birth_date, terms_accepted_at)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'name', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'phone',
    nullif(new.raw_user_meta_data->>'birth_date', '')::date,
    nullif(new.raw_user_meta_data->>'terms_accepted_at', '')::timestamptz
  );
  return new;
end;
$function$;
