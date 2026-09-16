import { Router } from "express";
import { db, withTransaction } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createOrderSchema, orderStatusUpdateSchema, validate } from "../validation/schemas.js";

export const ordersRouter = Router();

const MIN_ORDER_CENTS = 1000; // RN01: pedido mínimo de R$ 10,00
const SERVICE_FEE = 0.10; // 10% de taxa de serviço
const VALID_TRANSITIONS = {
  "Na Fila": ["Em Preparo", "Cancelado"],
  "Em Preparo": ["Pronto"],
  Pronto: ["Entregue"],
};

function itemsOf(orderId) {
  return db
    .prepare(
      `SELECT product_id AS productId, product_name_snapshot AS name, qty,
              unit_price_cents AS unitPriceCents, note
       FROM order_items WHERE order_id = ?`
    )
    .all(orderId)
    .map((it) => ({ ...it, unitPrice: it.unitPriceCents / 100 }));
}

function toApi(row) {
  return {
    id: row.id,
    tableNumber: row.table_number,
    userId: row.user_id,
    status: row.status,
    subtotal: row.subtotal_cents / 100,
    total: row.total_cents / 100,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: itemsOf(row.id),
  };
}

// Cliente: cria um pedido. Todas as regras de negócio são checadas aqui,
// no servidor — o front pode ser enganado, o backend não.
ordersRouter.post("/", requireAuth, requireRole("cliente"), validate(createOrderSchema), (req, res) => {
  const { tableNumber, items, note } = req.body;

  const settings = db.prepare("SELECT * FROM kiosk_settings WHERE id = 1").get();
  if (settings.paused) {
    return res.status(409).json({ error: "Quiosque pausado no momento — não é possível fechar o pedido." });
  }

  const table = db.prepare("SELECT * FROM tables WHERE number = ?").get(tableNumber);
  if (!table) {
    return res.status(404).json({ error: `Mesa ${tableNumber} não existe.` });
  }
  if (!table.active) {
    return res.status(409).json({ error: `Mesa ${tableNumber} está inativa. Procure um atendente.` });
  }

  const productIds = items.map((i) => i.productId);
  const placeholders = productIds.map(() => "?").join(",");
  const products = db
    .prepare(`SELECT * FROM products WHERE id IN (${placeholders})`)
    .all(...productIds);
  const byId = new Map(products.map((p) => [p.id, p]));

  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) {
      return res.status(404).json({ error: `Produto ${item.productId} não encontrado.` });
    }
    if (product.sold_out) {
      return res.status(409).json({ error: `Item indisponível: ${product.name}.` });
    }
  }

  const subtotalCents = items.reduce((sum, item) => sum + byId.get(item.productId).price_cents * item.qty, 0);
  if (subtotalCents < MIN_ORDER_CENTS) {
    return res.status(422).json({ error: "Pedido mínimo de R$ 10,00 (RN01)." });
  }
  const totalCents = Math.round(subtotalCents * (1 + SERVICE_FEE));

  const insertOrder = db.prepare(
    `INSERT INTO orders (table_number, user_id, subtotal_cents, total_cents, note)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name_snapshot, qty, unit_price_cents, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const orderId = withTransaction(() => {
    const info = insertOrder.run(tableNumber, req.user.sub, subtotalCents, totalCents, note || "");
    for (const item of items) {
      const product = byId.get(item.productId);
      insertItem.run(info.lastInsertRowid, product.id, product.name, item.qty, product.price_cents, item.note || "");
    }
    return info.lastInsertRowid;
  });

  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  res.status(201).json(toApi(row));
});

// Cliente: histórico dos próprios pedidos.
ordersRouter.get("/mine", requireAuth, requireRole("cliente"), (req, res) => {
  const rows = db
    .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.sub);
  res.json(rows.map(toApi));
});

// Admin/cozinha: lista de pedidos (opcionalmente filtrada por status), para o kanban/painel.
ordersRouter.get("/", requireAuth, requireRole("admin", "cozinha"), (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at").all(status)
    : db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  res.json(rows.map(toApi));
});

// Qualquer papel autenticado pode ver o detalhe — cliente só o próprio pedido.
ordersRouter.get("/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (req.user.role === "cliente" && row.user_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para ver este pedido." });
  }
  res.json(toApi(row));
});

// Cliente: cancelar — RN04, só permitido enquanto o status for "Na Fila".
ordersRouter.post("/:id/cancel", requireAuth, requireRole("cliente"), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (row.user_id !== req.user.sub) {
    return res.status(403).json({ error: "Sem permissão para cancelar este pedido." });
  }
  if (row.status !== "Na Fila") {
    return res.status(409).json({
      error: `Cancelamento bloqueado (RN04): o pedido já está em "${row.status}".`,
    });
  }
  db.prepare("UPDATE orders SET status = 'Cancelado', updated_at = datetime('now') WHERE id = ?").run(id);
  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json(toApi(updated));
});

// Admin/cozinha: avançar o status no kanban (Na Fila -> Em Preparo -> Pronto -> Entregue).
ordersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin", "cozinha"),
  validate(orderStatusUpdateSchema),
  (req, res) => {
  const id = Number(req.params.id);
  const { status: next } = req.body;
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });

  const allowed = VALID_TRANSITIONS[row.status] || [];
  if (!allowed.includes(next)) {
    return res.status(422).json({
      error: `Transição inválida de "${row.status}" para "${next}".`,
      allowed,
    });
  }
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json(toApi(updated));
  }
);
