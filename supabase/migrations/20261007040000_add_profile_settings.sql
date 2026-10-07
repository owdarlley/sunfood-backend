-- Personalização do perfil: foto (enviada ou um avatar pronto) e os avisos
-- do pedido pronto (notificação e som). Nome, telefone e nascimento já
-- existiam; agora o próprio usuário edita pela tela Perfil (via API).
--
-- A foto fica guardada só pelo nome do arquivo no bucket "avatares" (a API
-- monta a URL). Como o usuário consegue atualizar a própria linha direto
-- pela API do Supabase (policy "profiles: update own"), o check impede que
-- ele aponte a foto pra um site qualquer.
alter table public.profiles
  add column if not exists avatar_path text,
  add column if not exists avatar_preset text,
  add column if not exists notify_ready boolean not null default true,
  add column if not exists sound_on boolean not null default true;

alter table public.profiles
  add constraint profiles_avatar_path_valid
    check (avatar_path is null or avatar_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$'),
  add constraint profiles_avatar_preset_valid
    check (avatar_preset is null or avatar_preset in ('sol','onda','coco','abacaxi','peixe','concha','palmeira','picole'));

-- Bucket público (a foto aparece no app sem precisar de token), sem policies
-- de escrita: só a API grava, com a service role, depois de conferir o arquivo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatares', 'avatares', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
