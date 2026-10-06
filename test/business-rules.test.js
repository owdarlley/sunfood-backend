import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TABLE_COUNT,
  DEFAULT_LOCATION,
  locationFrom,
  tableCountFrom,
  MIN_ORDER_CENTS,
  SERVICE_FEE_RATE,
  isValidTransition,
  computeOrderTotals,
  meetsMinimumOrder,
  minOrderCentsFrom,
  formatBRL,
  canCancel,
  canRecordReceipt,
  cancelWindowFrom,
  cancelDeadline,
  withinCancelWindow,
  awaitingOnlinePayment,
  needsRefund,
  paymentCoversOrder,
} from "../src/business-rules.js";

test("RN01: pedido abaixo de R$10 é rejeitado", () => {
  assert.equal(meetsMinimumOrder(999), false);
  assert.equal(meetsMinimumOrder(MIN_ORDER_CENTS), true);
  assert.equal(meetsMinimumOrder(MIN_ORDER_CENTS + 1), true);
});

test("RN01: mínimo configurável pelo admin", () => {
  assert.equal(meetsMinimumOrder(1499, 1500), false);
  assert.equal(meetsMinimumOrder(1500, 1500), true);
  assert.equal(meetsMinimumOrder(1, 0), true); // 0 = sem mínimo
});

test("minOrderCentsFrom usa o valor do banco e cai no padrão se faltar", () => {
  assert.equal(minOrderCentsFrom({ min_order_cents: 2500 }), 2500);
  assert.equal(minOrderCentsFrom({ min_order_cents: 0 }), 0);
  assert.equal(minOrderCentsFrom({ paused: false }), MIN_ORDER_CENTS);
  assert.equal(minOrderCentsFrom(null), MIN_ORDER_CENTS);
  assert.equal(formatBRL(1550), "R$ 15,50");
});

test("computeOrderTotals soma em centavos sem erro de ponto flutuante", () => {
  const items = [
    { productId: "a", qty: 3 }, // 3x R$ 0,10
    { productId: "b", qty: 1 }, // 1x R$ 0,20
  ];
  const priceCentsOf = (item) => (item.productId === "a" ? 10 : 20);
  const { subtotalCents, feeCents, totalCents } = computeOrderTotals(items, priceCentsOf);
  assert.equal(subtotalCents, 50); // 3*10 + 1*20 — não pode virar 49 ou 51 por float
  assert.equal(feeCents, Math.round(50 * SERVICE_FEE_RATE));
  assert.equal(totalCents, subtotalCents + feeCents);
});

test("RN04: só cancela enquanto 'Na Fila'", () => {
  assert.equal(canCancel("Na Fila"), true);
  assert.equal(canCancel("Em Preparo"), false);
  assert.equal(canCancel("Pronto"), false);
  assert.equal(canCancel("Entregue"), false);
  assert.equal(canCancel("Cancelado"), false);
});

test("transições de status do kanban seguem a ordem certa", () => {
  assert.equal(isValidTransition("Na Fila", "Em Preparo"), true);
  assert.equal(isValidTransition("Na Fila", "Cancelado"), true);
  assert.equal(isValidTransition("Em Preparo", "Pronto"), true);
  assert.equal(isValidTransition("Pronto", "Entregue"), true);
});

test("transições fora de ordem são rejeitadas (não pode pular etapa nem voltar)", () => {
  assert.equal(isValidTransition("Na Fila", "Pronto"), false);
  assert.equal(isValidTransition("Na Fila", "Entregue"), false);
  assert.equal(isValidTransition("Em Preparo", "Entregue"), false);
  assert.equal(isValidTransition("Em Preparo", "Cancelado"), false);
  assert.equal(isValidTransition("Pronto", "Na Fila"), false);
  assert.equal(isValidTransition("Entregue", "Na Fila"), false);
  assert.equal(isValidTransition("Cancelado", "Na Fila"), false);
});

test("pedido de PIX/cartão não pago fica fora da cozinha; na entrega entra direto", () => {
  assert.equal(awaitingOnlinePayment({ payment_method: "pix", payment_status: "pending" }), true);
  assert.equal(awaitingOnlinePayment({ payment_method: "cartao", payment_status: "rejected" }), true);
  assert.equal(awaitingOnlinePayment({ payment_method: "pix", payment_status: "approved" }), false);
  assert.equal(awaitingOnlinePayment({ payment_method: "entrega", payment_status: "pending" }), false);
});

test("só estorna pedido pago no app com pagamento identificado", () => {
  assert.equal(needsRefund({ payment_method: "pix", payment_status: "approved", payment_id: "123" }), true);
  assert.equal(needsRefund({ payment_method: "cartao", payment_status: "approved", payment_id: "456" }), true);
  assert.equal(needsRefund({ payment_method: "pix", payment_status: "pending", payment_id: "123" }), false);
  assert.equal(needsRefund({ payment_method: "entrega", payment_status: "approved", payment_id: null }), false);
});

test("pagamento aprovado precisa cobrir o total do pedido", () => {
  assert.equal(paymentCoversOrder(27.5, "27.50"), true);
  assert.equal(paymentCoversOrder(27.49, "27.50"), true); // 1 centavo de arredondamento
  assert.equal(paymentCoversOrder(20, "27.50"), false);
});

test("prazo de cancelamento: 0 ou ausente = sem prazo", () => {
  assert.equal(cancelWindowFrom({ cancel_window_minutes: 0 }), 0);
  assert.equal(cancelWindowFrom({}), 0);
  assert.equal(cancelWindowFrom(null), 0);
  assert.equal(cancelWindowFrom({ cancel_window_minutes: 5 }), 5);
  assert.equal(cancelDeadline("2026-10-05T12:00:00.000Z", 0), null);
  assert.equal(withinCancelWindow("2026-10-05T12:00:00.000Z", 0, Date.parse("2026-10-05T20:00:00Z")), true);
});

test("prazo de cancelamento: só dentro dos minutos configurados", () => {
  const criado = "2026-10-05T12:00:00.000Z";
  assert.equal(cancelDeadline(criado, 5), "2026-10-05T12:05:00.000Z");
  assert.equal(withinCancelWindow(criado, 5, Date.parse("2026-10-05T12:04:59Z")), true);
  assert.equal(withinCancelWindow(criado, 5, Date.parse("2026-10-05T12:05:00Z")), true);
  assert.equal(withinCancelWindow(criado, 5, Date.parse("2026-10-05T12:05:01Z")), false);
});

test("recebimento na entrega: só pedido 'entrega' que não foi cancelado", () => {
  assert.equal(canRecordReceipt({ payment_method: "entrega", status: "Entregue" }), true);
  assert.equal(canRecordReceipt({ payment_method: "entrega", status: "Na Fila" }), true);
  assert.equal(canRecordReceipt({ payment_method: "entrega", status: "Cancelado" }), false);
  assert.equal(canRecordReceipt({ payment_method: "pix", status: "Entregue" }), false);
});

test("tableCountFrom usa a quantidade de mesas do banco e cai no padrão se faltar", () => {
  assert.equal(tableCountFrom({ table_count: 30 }), 30);
  assert.equal(tableCountFrom({ table_count: 0 }), DEFAULT_TABLE_COUNT);
  assert.equal(tableCountFrom({ paused: false }), DEFAULT_TABLE_COUNT);
  assert.equal(tableCountFrom(null), DEFAULT_TABLE_COUNT);
});

test("locationFrom usa o local do banco e cai no padrão se faltar", () => {
  assert.deepEqual(locationFrom({ location_name: " Faculdade ", location_address: "Rua A, 10", location_hours: "" }), { name: "Faculdade", address: "Rua A, 10", hours: "" });
  assert.deepEqual(locationFrom({ paused: false }), DEFAULT_LOCATION);
  assert.deepEqual(locationFrom(null), DEFAULT_LOCATION);
  assert.equal(locationFrom({ location_name: "  ", location_address: "Rua A, 10" }).name, DEFAULT_LOCATION.name);
});
