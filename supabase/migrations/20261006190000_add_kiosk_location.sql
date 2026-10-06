-- Localização do quiosque configurável pelo admin (tela "Quiosque e mesas").
-- O app do cliente mostra nome, endereço e horário na tela "Localização do
-- quiosque" e monta o mapa e o botão "Abrir no mapa" a partir do endereço.
-- Os padrões são o texto que estava fixo no app até agora.
alter table public.kiosk_settings
  add column location_name text not null default 'Quiosque Sunfood · Praia do Forte',
  add column location_address text not null default 'Av. Beira-Mar, s/n, em frente ao posto 4',
  add column location_hours text not null default 'Aberto todos os dias, 9h às 18h.',
  add constraint kiosk_settings_location_name_check check (char_length(btrim(location_name)) between 1 and 80),
  add constraint kiosk_settings_location_address_check check (char_length(btrim(location_address)) between 1 and 200),
  add constraint kiosk_settings_location_hours_check check (char_length(location_hours) <= 120);
