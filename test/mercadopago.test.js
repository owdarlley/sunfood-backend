import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-de-teste";
const { verifyWebhookSignature, toOrderPaymentStatus, mpDate } = await import("../src/payments/mercadopago.js");

function sign(dataId, requestId, ts, secret) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return crypto.createHmac("sha256", secret).update(manifest).digest("hex");
}

test("aceita uma assinatura de webhook válida", () => {
  const dataId = "123456", requestId = "req-1", ts = String(Date.now());
  const v1 = sign(dataId, requestId, ts, "segredo-de-teste");
  const ok = verifyWebhookSignature({ signatureHeader: `ts=${ts},v1=${v1}`, requestId, dataId });
  assert.equal(ok, true);
});

test("rejeita quando a assinatura não bate (secret errado)", () => {
  const dataId = "123456", requestId = "req-1", ts = String(Date.now());
  const v1 = sign(dataId, requestId, ts, "secret-errado");
  const ok = verifyWebhookSignature({ signatureHeader: `ts=${ts},v1=${v1}`, requestId, dataId });
  assert.equal(ok, false);
});

test("rejeita quando o dataId foi trocado (payload adulterado)", () => {
  const requestId = "req-1", ts = String(Date.now());
  const v1 = sign("123456", requestId, ts, "segredo-de-teste");
  // assinatura calculada pro pagamento 123456, mas o dataId enviado é outro
  const ok = verifyWebhookSignature({ signatureHeader: `ts=${ts},v1=${v1}`, requestId, dataId: "999999" });
  assert.equal(ok, false);
});

test("rejeita cabeçalho de assinatura ausente ou malformado", () => {
  assert.equal(verifyWebhookSignature({ signatureHeader: undefined, requestId: "r", dataId: "1" }), false);
  assert.equal(verifyWebhookSignature({ signatureHeader: "lixo-sem-formato", requestId: "r", dataId: "1" }), false);
});

test("traduz os status do Mercado Pago pros status do pedido", () => {
  assert.equal(toOrderPaymentStatus("approved"), "approved");
  assert.equal(toOrderPaymentStatus("rejected"), "rejected");
  assert.equal(toOrderPaymentStatus("refunded"), "refunded");
  assert.equal(toOrderPaymentStatus("charged_back"), "refunded");
  assert.equal(toOrderPaymentStatus("cancelled"), "cancelled");
  assert.equal(toOrderPaymentStatus("in_process"), "pending");
});

test("data no formato que o Mercado Pago aceita (com milissegundos e fuso -03:00)", () => {
  assert.equal(mpDate(new Date("2026-10-04T21:30:00.000Z")), "2026-10-04T18:30:00.000-03:00");
});
