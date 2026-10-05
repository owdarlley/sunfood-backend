// Regras de negócio puras (sem depender de Express/Supabase), pra dar pra
// testar direto sem precisar de um banco de verdade.

export const MIN_ORDER_CENTS = 1000; // RN01: pedido mínimo de R$ 10,00
export const SERVICE_FEE_RATE = 0.1; // 10% de taxa de serviço

export const VALID_TRANSITIONS = {
  "Na Fila": ["Em Preparo", "Cancelado"],
  "Em Preparo": ["Pronto"],
  Pronto: ["Entregue"],
};

export function isValidTransition(currentStatus, nextStatus) {
  return (VALID_TRANSITIONS[currentStatus] || []).includes(nextStatus);
}

// Soma em centavos (evita erro de ponto flutuante) e devolve subtotal/taxa/
// total também em centavos — quem chama decide a formatação em reais.
export function computeOrderTotals(items, priceCentsOf) {
  const subtotalCents = items.reduce((sum, item) => sum + priceCentsOf(item) * item.qty, 0);
  const feeCents = Math.round(subtotalCents * SERVICE_FEE_RATE);
  return { subtotalCents, feeCents, totalCents: subtotalCents + feeCents };
}

export function meetsMinimumOrder(subtotalCents) {
  return subtotalCents >= MIN_ORDER_CENTS;
}

// RN04: só pode cancelar enquanto o pedido está "Na Fila".
export function canCancel(status) {
  return status === "Na Fila";
}

// Prazo para o cliente cancelar, em minutos contados a partir do pedido. O
// quiosque escolhe em kiosk_settings.cancel_window_minutes; 0 = sem prazo
// (vale só a regra do "Na Fila", como era antes).
export const DEFAULT_CANCEL_WINDOW_MINUTES = 0;
export const MAX_CANCEL_WINDOW_MINUTES = 120;

export function cancelWindowFrom(settings) {
  const v = settings?.cancel_window_minutes;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_CANCEL_WINDOW_MINUTES;
}

// Horário limite pra cancelar (ISO) ou null quando não há prazo.
export function cancelDeadline(createdAt, windowMinutes) {
  if (!windowMinutes) return null;
  return new Date(new Date(createdAt).getTime() + windowMinutes * 60 * 1000).toISOString();
}

export function withinCancelWindow(createdAt, windowMinutes, now = Date.now()) {
  const deadline = cancelDeadline(createdAt, windowMinutes);
  return deadline === null || now <= new Date(deadline).getTime();
}

// Formas de pagamento: PIX e cartão são pagos no app (Mercado Pago) antes de
// a cozinha começar; "entrega" é pago ao garçom (maquininha ou dinheiro).
export const PAYMENT_METHODS = ["pix", "cartao", "entrega"];

// Pedido pago no app que ainda não teve o pagamento confirmado — não pode
// entrar em preparo nem aparecer pra cozinha.
export function awaitingOnlinePayment(order) {
  return order.payment_method !== "entrega" && order.payment_status !== "approved";
}

// Como o garçom recebeu um pedido "pagar na entrega" (registrado pelo admin).
export const RECEIVED_WITH = ["dinheiro", "cartao", "pix"];

// Só pedido "na entrega" e ainda não cancelado pode ter o recebimento anotado.
export function canRecordReceipt(order) {
  return order.payment_method === "entrega" && order.status !== "Cancelado";
}

// Cancelar um pedido já pago no app exige devolver o dinheiro.
export function needsRefund(order) {
  return order.payment_method !== "entrega" && order.payment_status === "approved" && !!order.payment_id;
}

// O pagamento aprovado precisa cobrir o total do pedido (tolerância de 1
// centavo por arredondamento) — evita liberar pedido pago a menor.
export function paymentCoversOrder(paidAmount, orderTotal) {
  return Math.round(Number(paidAmount) * 100) >= Math.round(Number(orderTotal) * 100) - 1;
}
