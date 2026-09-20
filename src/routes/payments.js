import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createPixPayment,
  fetchPaymentStatus,
  verifyWebhookSignature,
  paymentsConfigured,
} from "../payments/mercadopago.js";

export const paymentsRouter = Router();

const pixLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de pagamento. Tente novamente em alguns minutos." },
});

// O front usa isso pra saber se mostra o QR real ou o aviso de "ambiente de
// testes" — nunca finge que está cobrando de verdade sem token configurado.
paymentsRouter.get("/status", (req, res) => res.json({ configured: paymentsConfigured }));

// Cliente: gera a cobrança PIX do próprio pedido.
paymentsRouter.post("/pix/:orderId", requireAuth, requireRole("cliente"), pixLimiter, async (req, res) => {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", req.params.orderId)
    .maybeSingle();
  if (error || !order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (order.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para este pedido." });
  }
  if (order.payment_status === "approved") {
    return res.status(409).json({ error: "Este pedido já está pago." });
  }

  const base = process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const payment = await createPixPayment({
      orderId: order.id,
      amount: Number(order.total),
      payerEmail: req.user.email,
      notificationUrl: `${base}/payments/mercadopago/webhook`,
      description: `Pedido Sunfood — mesa ${order.table_number}`,
    });
    await supabaseAdmin
      .from("orders")
      .update({ payment_provider: "mercadopago", payment_id: payment.paymentId })
      .eq("id", order.id);
    res.json({
      simulated: payment.simulated,
      qrCode: payment.qrCode,
      qrCodeBase64: payment.qrCodeBase64,
      status: payment.status,
    });
  } catch (e) {
    console.error("Erro ao criar pagamento PIX:", e);
    res.status(502).json({ error: "Falha ao gerar cobrança PIX. Tente novamente." });
  }
});

// Cliente: consulta o status de pagamento do próprio pedido — usado pro app
// dar polling além de depender só do webhook (rede de segurança).
paymentsRouter.get("/pix/:orderId/status", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("customer_id, payment_status")
    .eq("id", req.params.orderId)
    .maybeSingle();
  if (error || !order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (order.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para este pedido." });
  }
  res.json({ paymentStatus: order.payment_status });
});

// Mercado Pago chama isso quando um pagamento muda de status. É público (eles
// não têm como mandar nosso token), então a assinatura é validada e o status
// usado pra liberar o pedido é sempre rebuscado na API deles — nunca o valor
// que vier no corpo da notificação.
paymentsRouter.post("/mercadopago/webhook", async (req, res) => {
  if (!paymentsConfigured) return res.status(200).end(); // modo simulado: não há integração real pra confirmar

  const dataId = req.body?.data?.id || req.query.id;
  const isPaymentEvent = req.body?.type === "payment" || req.query.type === "payment" || req.body?.action?.startsWith("payment");
  if (!isPaymentEvent || !dataId) return res.status(200).end();

  const ok = verifyWebhookSignature({
    signatureHeader: req.headers["x-signature"],
    requestId: req.headers["x-request-id"],
    dataId,
  });
  if (!ok) return res.status(401).json({ error: "Assinatura inválida." });

  try {
    const { status, externalReference } = await fetchPaymentStatus(dataId);
    if (!externalReference) return res.status(200).end();

    const paymentStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending";
    await supabaseAdmin.from("orders").update({ payment_status: paymentStatus }).eq("id", externalReference);
    res.status(200).end();
  } catch (e) {
    console.error("Erro ao processar webhook Mercado Pago:", e);
    res.status(500).end();
  }
});
