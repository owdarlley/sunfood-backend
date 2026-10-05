-- Prazo para o cliente cancelar o pedido pelo app, em minutos contados a
-- partir do pedido, escolhido pelo admin. 0 = sem prazo: vale só a regra de
-- antes (pode cancelar enquanto estiver "Na Fila").
alter table public.kiosk_settings
  add column cancel_window_minutes integer not null default 0,
  add constraint kiosk_settings_cancel_window_minutes_check check (cancel_window_minutes between 0 and 120);
