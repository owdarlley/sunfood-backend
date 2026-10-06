-- Foto do produto enviada pelo admin. Vazio = o cardápio usa a ilustração
-- padrão (coluna mark), como antes.
alter table public.products
  add column if not exists image_url text;

-- Bucket público só para leitura: o cardápio mostra as fotos sem login.
-- Não criamos policies de escrita em storage.objects de propósito: quem grava
-- é a API (service role), que confere se a pessoa é admin. Sem policy, nenhum
-- usuário comum consegue enviar/apagar arquivos direto pelo Supabase.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('produtos', 'produtos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
