import crypto from "node:crypto";
import { MercadoPagoConfig, Payment, PaymentRefund, Preference } from "mercadopago";

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;

// Sem token configurado, as rotas de pagamento nem chamam este módulo: PIX e
// cartão são aprovados na hora como "provisorio" (ver routes/payments.js).
export const paymentsConfigured = !!ACCESS_TOKEN;

let clients = null;
function mpClients() {
  if (!clients) {
    const mp = new MercadoPagoConfig({ accessToken: ACCESS_TOKEN });
    clients = { payment: new Payment(mp), refund: new PaymentRefund(mp), preference: new Preference(mp) };
  }
  return clients;
}
const client = () => mpClients().payment;

// Por quanto tempo uma cobrança online fica aberta. Depois disso o PIX expira
// no Mercado Pago e o pedido não pago sai da fila (ver orders.js).
export const PAYMENT_WINDOW_MINUTES = 30;

// O Mercado Pago exige data com milissegundos e fuso explícito
// (ex.: 2026-10-04T18:30:00.000-03:00) — toISOString() devolve "Z".
export function mpDate(date) {
  const brt = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().replace("Z", "-03:00");
}

// Traduz o status do Mercado Pago pros valores aceitos em orders.payment_status.
export function toOrderPaymentStatus(mpStatus) {
  if (mpStatus === "approved") return "approved";
  if (mpStatus === "rejected") return "rejected";
  if (mpStatus === "refunded" || mpStatus === "charged_back") return "refunded";
  if (mpStatus === "cancelled") return "cancelled";
  return "pending";
}

// Cria uma cobrança PIX real pelo valor do pedido. Retorna o código
// copia-e-cola e o QR code em base64 pra tela mostrar, mais o id do
// pagamento (guardado no pedido pra casar com o webhook depois).
export async function createPixPayment({ orderId, amount, payerEmail, notificationUrl, description }) {
  const result = await client().create({
    body: {
      transaction_amount: Number(amount.toFixed(2)),
      description: description || `Pedido Sunfood #${orderId}`,
      payment_method_id: "pix",
      payer: { email: payerEmail },
      notification_url: notificationUrl,
      external_reference: orderId,
      date_of_expiration: mpDate(new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000)),
    },
  });

  const txData = result.point_of_interaction?.transaction_data;
  return {
    paymentId: String(result.id),
    status: result.status, // 'pending' até o pagador escanear e pagar
    qrCode: txData?.qr_code || null,
    qrCodeBase64: txData?.qr_code_base64 || null,
  };
}

// Cartão: cria um checkout do Mercado Pago (Checkout Pro) e devolve o link
// pra onde o cliente é levado. Os dados do cartão são digitados na página do
// próprio Mercado Pago — nunca passam pelo app nem pelo nosso servidor.
export async function createCardCheckout({ orderId, amount, payerEmail, notificationUrl, returnUrl, description }) {
  const now = Date.now();
  const result = await mpClients().preference.create({
    body: {
      items: [
        {
          id: orderId,
          title: description || `Pedido Sunfood #${orderId}`,
          quantity: 1,
          unit_price: Number(amount.toFixed(2)),
          currency_id: "BRL",
        },
      ],
      payer: { email: payerEmail },
      external_reference: orderId,
      notification_url: notificationUrl,
      back_urls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
      auto_return: "approved",
      // Só cartão aqui: PIX já tem o fluxo próprio no app, e boleto não
      // serve pra comida entregue na hora.
      payment_methods: {
        excluded_payment_types: [{ id: "ticket" }, { id: "atm" }, { id: "bank_transfer" }],
        installments: 1,
      },
      expires: true,
      expiration_date_from: mpDate(new Date(now - 60 * 1000)),
      expiration_date_to: mpDate(new Date(now + PAYMENT_WINDOW_MINUTES * 60 * 1000)),
    },
  });

  return { preferenceId: String(result.id), checkoutUrl: result.init_point };
}

// Pedidos antigos, do extinto modo simulado, têm payment_id "sim_<pedido>":
// nunca houve cobrança, então não há o que estornar nem consultar.

// Devolve o valor total de um pagamento aprovado (cancelamento de pedido pago).
export async function refundPayment(paymentId) {
  if (String(paymentId).startsWith("sim_")) return { simulated: true };
  const result = await mpClients().refund.total({ payment_id: paymentId });
  return { simulated: false, refundId: String(result.id), status: result.status };
}

// Nunca confiar no corpo do webhook pra decidir se algo foi pago — ele só
// diz "olha, o pagamento X mudou", e o status de verdade é buscado de volta
// na API do Mercado Pago com nosso próprio access token.
export async function fetchPaymentStatus(paymentId) {
  if (String(paymentId).startsWith("sim_")) {
    return { status: "pending", externalReference: paymentId.replace("sim_", "") };
  }
  const result = await client().get({ id: paymentId });
  return {
    status: result.status,
    externalReference: result.external_reference,
    amount: Number(result.transaction_amount),
    methodType: result.payment_type_id, // 'bank_transfer' (PIX), 'credit_card', 'debit_card'...
  };
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
