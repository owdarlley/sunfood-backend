-- Recebimento de pedidos "pagar na entrega": o admin anota como o garçom
-- recebeu (dinheiro, cartão na maquininha ou PIX do quiosque) e quando.
-- Fica tudo no banco, pra tela de Pagamentos mostrar todas as transações.
alter table public.orders
  add column received_with text null,
  add column received_at timestamptz null,
  add constraint orders_received_with_check check (received_with is null or received_with in ('dinheiro', 'cartao', 'pix'));
