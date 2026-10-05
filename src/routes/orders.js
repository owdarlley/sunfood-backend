import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createOrderSchema, orderStatusUpdateSchema, paymentReceivedSchema, validate } from "../validation/schemas.js";
import {
  computeOrderTotals,
  meetsMinimumOrder,
  minOrderCentsFrom,
  formatBRL,
  canCancel,
  cancelWindowFrom,
  cancelDeadline,
  withinCancelWindow,
  isValidTransition,
  awaitingOnlinePayment,
  canRecordReceipt,
  VALID_TRANSITIONS,
} from "../business-rules.js";
import { cancelOrderWithRefund, expireUnpaidOrders } from "../order-payments.js";

export const ordersRouter = Router();

// Trava contra spam de pedidos (bug de cliente ou tentativa de abuso) — bem
// mais generoso que o limite de login, já que é uso normal repetir pedidos.
const createOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitos pedidos em pouco tempo. Aguarde um instante." },
});

// Prazo de cancelamento configurado pelo quiosque (0 = sem prazo).
async function loadCancelWindow() {
  const { data } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).maybeSingle();
  return cancelWindowFrom(data);
}

// cancelWindow só é passado nas respostas pro cliente: o app usa
// cancelDeadline pra mostrar até que horas dá pra cancelar.
function toApi(row, cancelWindow) {
  return {
    id: row.id,
    tableNumber: row.table_number,
    userId: row.customer_id,
    status: row.status,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    note: row.note,
    paymentMethod: row.payment_method,
    paymentProvider: row.payment_provider,
    paymentId: row.payment_id,
    paymentStatus: row.payment_status,
    receivedWith: row.received_with,
    receivedAt: row.received_at,
    cancelDeadline: cancelWindow === undefined ? undefined : cancelDeadline(row.created_at, cancelWindow),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: (row.order_items || []).map((it) => ({
      productId: it.product_id,
      name: it.name,
      qty: it.qty,
      unitPrice: Number(it.price),
      note: it.note,
    })),
  };
}

const ORDER_SELECT = "*, order_items(*)";

// Cliente: cria um pedido. Todas as regras de negócio são checadas aqui,
// no servidor — o front pode ser enganado, o backend não.
ordersRouter.post("/", requireAuth, requireRole("cliente"), createOrderLimiter, validate(createOrderSchema), async (req, res) => {
  const { tableNumber, items, note, paymentMethod } = req.body;

  const { data: settings } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single();
  if (settings?.paused) {
    return res.status(409).json({ error: "Quiosque pausado no momento — não é possível fechar o pedido." });
  }
  if (settings?.day_closed) {
    return res.status(409).json({ error: "O quiosque já encerrou o dia — não é possível fechar o pedido." });
  }

  const { data: table } = await supabaseAdmin
    .from("kiosk_tables")
    .select("*")
    .eq("number", tableNumber)
    .maybeSingle();
  if (!table) return res.status(404).json({ error: `Mesa ${tableNumber} não existe.` });
  if (!table.active) {
    return res.status(409).json({ error: `Mesa ${tableNumber} está inativa. Procure um atendente.` });
  }

  const productIds = items.map((i) => i.productId);
  const { data: products, error: productsError } = await supabaseAdmin
    .from("products")
    .select("*")
    .in("id", productIds);
  if (productsError) return res.status(500).json({ error: "Erro ao validar itens do pedido." });

  const byId = new Map(products.map((p) => [p.id, p]));
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) return res.status(404).json({ error: `Produto ${item.productId} não encontrado.` });
    if (product.sold_out) return res.status(409).json({ error: `Item indisponível: ${product.name}.` });
    if (product.stock_qty !== null && product.stock_qty < item.qty) {
      return res.status(409).json({ error: `Estoque insuficiente: ${product.name} (restam ${product.stock_qty}).` });
    }
  }

  // Aritmética em centavos pra não acumular erro de ponto flutuante, e só
  // volta pra reais decimais na hora de gravar.
  const priceCentsOf = (item) => Math.round(Number(byId.get(item.productId).price) * 100);
  const { subtotalCents, feeCents, totalCents } = computeOrderTotals(items, priceCentsOf);
  const minOrderCents = minOrderCentsFrom(settings);
  if (!meetsMinimumOrder(subtotalCents, minOrderCents)) {
    return res.status(422).json({ error: `Pedido mínimo de ${formatBRL(minOrderCents)}.` });
  }

  const { data: created, error: createError } = await supabaseAdmin.rpc("create_order", {
    payload: {
      customerId: req.user.sub,
      tableNumber,
      subtotal: subtotalCents / 100,
      fee: feeCents / 100,
      total: totalCents / 100,
      note: note || "",
      paymentMethod,
      items: items.map((item) => {
        const product = byId.get(item.productId);
        return { productId: product.id, name: product.name, price: Number(product.price), qty: item.qty, note: item.note || "" };
      }),
    },
  });
  if (createError) {
    // Corrida entre dois pedidos concorrentes: o pré-check acima passou, mas
    // o estoque esgotou entre a checagem e o lock da linha dentro do RPC.
    if (createError.message?.startsWith("out_of_stock:")) {
      return res.status(409).json({ error: `Estoque insuficiente: ${createError.message.slice("out_of_stock:".length)}.` });
    }
    return res.status(500).json({ error: "Não foi possível registrar o pedido." });
  }

  const { data: row } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", created.id).single();
  res.status(201).json(toApi(row, cancelWindowFrom(settings)));
});

// Cliente: histórico dos próprios pedidos.
ordersRouter.get("/mine", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("customer_id", req.user.sub)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Erro ao carregar histórico." });
  res.json(data.map(toApi));
});

// Admin/cozinha: lista de pedidos (opcionalmente filtrada por status), para o kanban/painel.
// A cozinha não vê pedido de PIX/cartão ainda não pago; o admin vê tudo.
ordersRouter.get("/", requireAuth, requireRole("admin", "cozinha"), async (req, res) => {
  await expireUnpaidOrders();
  const { status } = req.query;
  let query = supabaseAdmin.from("orders").select(ORDER_SELECT).order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "Erro ao carregar pedidos." });
  const visible = req.user.role === "cozinha" ? data.filter((row) => !awaitingOnlinePayment(row)) : data;
  res.json(visible.map(toApi));
});

// Qualquer papel autenticado pode ver o detalhe — cliente só o próprio pedido.
ordersRouter.get("/:id", requireAuth, async (req, res) => {
  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (req.user.role === "cliente" && row.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para ver este pedido." });
  }
  res.json(toApi(row, req.user.role === "cliente" ? await loadCancelWindow() : undefined));
});

// Cliente: cancelar — RN04, só permitido enquanto o status for "Na Fila" e
// dentro do prazo em minutos que o quiosque configurou.
// Pedido já pago no app é estornado no mesmo meio de pagamento.
ordersRouter.post("/:id/cancel", requireAuth, requireRole("cliente"), async (req, res) => {
  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (row.customer_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para cancelar este pedido." });
  }
  if (!canCancel(row.status)) {
    return res.status(409).json({
      error: `Cancelamento bloqueado (RN04): o pedido já está em "${row.status}".`,
    });
  }
  const cancelWindow = await loadCancelWindow();
  if (!withinCancelWindow(row.created_at, cancelWindow)) {
    return res.status(409).json({
      error: `O prazo para cancelar pelo app (${cancelWindow} min depois do pedido) já passou. Fale com um atendente.`,
    });
  }

  const result = await cancelOrderWithRefund(row);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });

  const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
  res.json(toApi(updated, cancelWindow));
});

// Admin: anota que o garçom recebeu um pedido "pagar na entrega" (dinheiro,
// cartão na maquininha ou PIX do quiosque), ou desfaz com receivedWith null.
// É o que deixa a tela de Pagamentos do admin com todas as transações.
ordersRouter.patch(
  "/:id/payment-received",
  requireAuth,
  requireRole("admin"),
  validate(paymentReceivedSchema),
  async (req, res) => {
    const { data: row, error } = await supabaseAdmin.from("orders").select("*").eq("id", req.params.id).maybeSingle();
    if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });
    if (!canRecordReceipt(row)) {
      return res.status(409).json({ error: "Só dá para anotar recebimento de pedido \"pagar na entrega\" que não foi cancelado." });
    }
    const { receivedWith } = req.body;
    const { error: updError } = await supabaseAdmin
      .from("orders")
      .update(
        receivedWith
          ? { payment_status: "approved", received_with: receivedWith, received_at: new Date().toISOString() }
          : { payment_status: "pending", received_with: null, received_at: null }
      )
      .eq("id", row.id);
    if (updError) return res.status(500).json({ error: "Não foi possível salvar o recebimento." });
    const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
    res.json(toApi(updated));
  }
);

// Admin/cozinha: avançar o status no kanban (Na Fila -> Em Preparo -> Pronto -> Entregue).
ordersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin", "cozinha"),
  validate(orderStatusUpdateSchema),
  async (req, res) => {
    const { status: next } = req.body;
    const { data: row, error } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error || !row) return res.status(404).json({ error: "Pedido não encontrado." });

    if (!isValidTransition(row.status, next)) {
      return res.status(422).json({
        error: `Transição inválida de "${row.status}" para "${next}".`,
        allowed: VALID_TRANSITIONS[row.status] || [],
      });
    }

    if (next === "Em Preparo" && awaitingOnlinePayment(row)) {
      return res.status(409).json({ error: "Pedido ainda não foi pago — aguarde a confirmação do pagamento." });
    }

    if (next === "Cancelado") {
      const result = await cancelOrderWithRefund(row);
      if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
    } else {
      const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
        p_order_id: row.id,
        p_status: next,
      });
      if (rpcError) return res.status(500).json({ error: "Não foi possível atualizar o pedido." });
    }

    const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
    res.json(toApi(updated));
  }
);
