import crypto from "node:crypto";
import { MercadoPagoConfig, Payment } from "mercadopago";

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;

// Sem token configurado, o checkout roda em modo simulado (nenhuma chamada
// de rede é feita) — assim o resto do app continua testável antes de você
// ter uma conta Mercado Pago aprovada. Isso NUNCA deve ficar assim em
// produção: sem token real, nenhum PIX gerado aqui cobra dinheiro de verdade.
export const paymentsConfigured = !!ACCESS_TOKEN;

let paymentClient = null;
function client() {
  if (!paymentClient) {
    const mp = new MercadoPagoConfig({ accessToken: ACCESS_TOKEN });
    paymentClient = new Payment(mp);
  }
  return paymentClient;
}

// Cria uma cobrança PIX real pelo valor do pedido. Retorna o código
// copia-e-cola e o QR code em base64 pra tela mostrar, mais o id do
// pagamento (guardado no pedido pra casar com o webhook depois).
export async function createPixPayment({ orderId, amount, payerEmail, notificationUrl, description }) {
  if (!paymentsConfigured) {
    return {
      simulated: true,
      paymentId: `sim_${orderId}`,
      status: "pending",
      qrCode: null,
      qrCodeBase64: null,
    };
  }

  const result = await client().create({
    body: {
      transaction_amount: Number(amount.toFixed(2)),
      description: description || `Pedido Sunfood #${orderId}`,
      payment_method_id: "pix",
      payer: { email: payerEmail },
      notification_url: notificationUrl,
      external_reference: orderId,
    },
  });

  const txData = result.point_of_interaction?.transaction_data;
  return {
    simulated: false,
    paymentId: String(result.id),
    status: result.status, // 'pending' até o pagador escanear e pagar
    qrCode: txData?.qr_code || null,
    qrCodeBase64: txData?.qr_code_base64 || null,
  };
}

// Nunca confiar no corpo do webhook pra decidir se algo foi pago — ele só
// diz "olha, o pagamento X mudou", e o status de verdade é buscado de volta
// na API do Mercado Pago com nosso próprio access token.
export async function fetchPaymentStatus(paymentId) {
  if (String(paymentId).startsWith("sim_")) {
    return { status: "pending", externalReference: paymentId.replace("sim_", "") };
  }
  const result = await client().get({ id: paymentId });
  return { status: result.status, externalReference: result.external_reference };
}

// Valida a assinatura HMAC do webhook (cabeçalhos x-signature/x-request-id),
// conforme documentado pelo Mercado Pago. Sem MERCADOPAGO_WEBHOOK_SECRET
// configurado, pula a validação — mas fetchPaymentStatus() acima já garante
// que o status usado pra liberar o pedido vem sempre da API, nunca do corpo
// do webhook em si.
export function verifyWebhookSignature({ signatureHeader, requestId, dataId }) {
  if (!WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k?.trim(), v?.trim()];
    })
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(manifest).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
