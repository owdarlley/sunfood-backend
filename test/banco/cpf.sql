-- Teste no banco (Supabase) do CPF no cadastro. Termina com erro DE
-- PROPÓSITO: o Postgres desfaz tudo, nenhum perfil de teste fica gravado.
-- Passou = a mensagem começa com TESTE_CPF_PASSOU.
do $$
declare
  ok boolean; a uuid; b uuid; log text := '';
begin
  -- 1. dígitos verificadores
  if not is_valid_cpf('52998224725') then raise exception 'FALHA CPF válido recusado'; end if;
  if not is_valid_cpf('11144477735') then raise exception 'FALHA CPF válido recusado (2)'; end if;
  if is_valid_cpf('52998224724') then raise exception 'FALHA CPF com dígito errado aceito'; end if;
  if is_valid_cpf('11111111111') then raise exception 'FALHA CPF repetido aceito'; end if;
  if is_valid_cpf('529.982.247-25') then raise exception 'FALHA CPF com pontuação aceito no banco'; end if;
  if is_valid_cpf('5299822472') then raise exception 'FALHA CPF com 10 dígitos aceito'; end if;
  log := log || 'dígitos verificadores OK; ';

  -- 2. a tabela recusa CPF inválido e CPF repetido
  select id into a from profiles where role = 'cliente' order by created_at limit 1;
  select id into b from profiles where role = 'cliente' and id <> a order by created_at limit 1;
  ok := false;
  begin update profiles set cpf = '12345678900' where id = a; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FALHA perfil aceitou CPF inválido'; end if;
  update profiles set cpf = null where cpf = '52998224725';
  update profiles set cpf = '52998224725' where id = a;
  if b is not null then
    ok := false;
    begin update profiles set cpf = '52998224725' where id = b; exception when unique_violation then ok := true; end;
    if not ok then raise exception 'FALHA duas contas com o mesmo CPF'; end if;
    log := log || 'CPF único por conta OK; ';
  end if;
  log := log || 'CPF inválido recusado OK';

  raise exception 'TESTE_CPF_PASSOU: %', log;
end $$;
