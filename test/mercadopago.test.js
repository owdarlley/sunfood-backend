import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-de-teste";
const { verifyWebhookSignature } = await import("../src/payments/mercadopago.js");

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
