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
