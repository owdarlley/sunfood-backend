-- Mensagens do "Fale conosco" do site. Quem envia não precisa estar logado;
-- a administração lê e marca como respondida pelo app (tela Mensagens).
-- Só o backend (service role) acessa: RLS ligado e nenhuma policy.
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique,
  name text not null check (char_length(name) between 2 and 120),
  contact text not null check (char_length(contact) between 5 and 160),
  reason text not null,
  message text not null check (char_length(message) between 10 and 2000),
  status text not null default 'novo' check (status in ('novo', 'respondido')),
  created_at timestamptz not null default now()
);

create index if not exists contact_messages_created_at_idx on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;
