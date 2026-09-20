import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createOrderSchema, orderStatusUpdateSchema, validate } from "../validation/schemas.js";

export const ordersRouter = Router();

const MIN_ORDER = 10; // RN01: pedido mínimo de R$ 10,00
const SERVICE_FEE_RATE = 0.1; // 10% de taxa de serviço
const VALID_TRANSITIONS = {
  "Na Fila": ["Em Preparo", "Cancelado"],
  "Em Preparo": ["Pronto"],
  Pronto: ["Entregue"],
};

function toApi(row) {
  return {
    id: row.id,
    tableNumber: row.table_number,
    userId: row.customer_id,
    status: row.status,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    note: row.note,
    paymentProvider: row.payment_provider,
    paymentId: row.payment_id,
    paymentStatus: row.payment_status,
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
ordersRouter.post("/", requireAuth, requireRole("cliente"), validate(createOrderSchema), async (req, res) => {
  const { tableNumber, items, note } = req.body;

  const { data: settings } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single();
  if (settings?.paused) {
    return res.status(409).json({ error: "Quiosque pausado no momento — não é possível fechar o pedido." });
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
  }

  // Aritmética em centavos pra não acumular erro de ponto flutuante, e só
  // volta pra reais decimais na hora de gravar.
  const subtotalCents = items.reduce(
    (sum, item) => sum + Math.round(Number(byId.get(item.productId).price) * 100) * item.qty,
    0
  );
  if (subtotalCents < MIN_ORDER * 100) {
    return res.status(422).json({ error: "Pedido mínimo de R$ 10,00 (RN01)." });
  }
  const feeCents = Math.round(subtotalCents * SERVICE_FEE_RATE);
  const totalCents = subtotalCents + feeCents;

  const { data: created, error: createError } = await supabaseAdmin.rpc("create_order", {
    payload: {
      customerId: req.user.sub,
      tableNumber,
      subtotal: subtotalCents / 100,
      fee: feeCents / 100,
      total: totalCents / 100,
      note: note || "",
      items: items.map((item) => {
        const product = byId.get(item.productId);
        return { productId: product.id, name: product.name, price: Number(product.price), qty: item.qty, note: item.note || "" };
      }),
    },
  });
  if (createError) return res.status(500).json({ error: "Não foi possível registrar o pedido." });

  const { data: row } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", created.id).single();
  res.status(201).json(toApi(row));
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
ordersRouter.get("/", requireAuth, requireRole("admin", "cozinha"), async (req, res) => {
  const { status } = req.query;
  let query = supabaseAdmin.from("orders").select(ORDER_SELECT).order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "Erro ao carregar pedidos." });
  res.json(data.map(toApi));
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
  res.json(toApi(row));
});

// Cliente: cancelar — RN04, só permitido enquanto o status for "Na Fila".
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
  if (row.status !== "Na Fila") {
    return res.status(409).json({
      error: `Cancelamento bloqueado (RN04): o pedido já está em "${row.status}".`,
    });
  }

  const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
    p_order_id: row.id,
    p_status: "Cancelado",
  });
  if (rpcError) return res.status(500).json({ error: "Não foi possível cancelar o pedido." });

  const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
  res.json(toApi(updated));
});

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

    const allowed = VALID_TRANSITIONS[row.status] || [];
    if (!allowed.includes(next)) {
      return res.status(422).json({
        error: `Transição inválida de "${row.status}" para "${next}".`,
        allowed,
      });
    }

    const { error: rpcError } = await supabaseAdmin.rpc("set_order_status", {
      p_order_id: row.id,
      p_status: next,
    });
    if (rpcError) return res.status(500).json({ error: "Não foi possível atualizar o pedido." });

    const { data: updated } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", row.id).single();
    res.json(toApi(updated));
  }
);
