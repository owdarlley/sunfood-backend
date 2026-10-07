-- Resposta do Fale conosco direto pela tela Mensagens do admin: guarda o
-- texto enviado, por onde foi (e-mail pela API ou WhatsApp pelo app) e quando.
alter table public.contact_messages
  add column if not exists reply text check (reply is null or char_length(reply) between 2 and 4000),
  add column if not exists reply_channel text check (reply_channel is null or reply_channel in ('email', 'whatsapp')),
  add column if not exists replied_at timestamptz;
