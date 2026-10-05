-- Pedido mínimo configurável pelo admin (RN01). Antes era fixo em R$ 10,00
-- no código; agora fica em kiosk_settings e o padrão continua R$ 10,00.
-- Guardado em centavos pra não ter erro de ponto flutuante.
alter table public.kiosk_settings
  add column min_order_cents integer not null default 1000,
  add constraint kiosk_settings_min_order_cents_check check (min_order_cents >= 0);
