import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { kioskPauseSchema, validate } from "../validation/schemas.js";

export const adminRouter = Router();

adminRouter.get("/kiosk-settings", (req, res) => {
  const row = db.prepare("SELECT * FROM kiosk_settings WHERE id = 1").get();
  res.json({ paused: !!row.paused, dayClosed: !!row.day_closed });
});

adminRouter.patch(
  "/kiosk-settings/pause",
  requireAuth,
  requireRole("admin"),
  validate(kioskPauseSchema),
  (req, res) => {
    db.prepare("UPDATE kiosk_settings SET paused = ? WHERE id = 1").run(req.body.paused ? 1 : 0);
    const row = db.prepare("SELECT * FROM kiosk_settings WHERE id = 1").get();
    res.json({ paused: !!row.paused, dayClosed: !!row.day_closed });
  }
);

// Dashboard: agregação real sobre os pedidos do dia corrente (substitui os KPIs
// mockados do protótipo, que eram sempre os mesmos números fixos).
adminRouter.get("/dashboard", requireAuth, requireRole("admin"), (req, res) => {
  const today = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue
       FROM orders
       WHERE date(created_at) = date('now') AND status != 'Cancelado'`
    )
    .get();
  const avgTicketCents = today.orders > 0 ? Math.round(today.revenue / today.orders) : 0;

  const topProducts = db
    .prepare(
      `SELECT oi.product_name_snapshot AS name, SUM(oi.qty) AS qty
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE date(o.created_at) = date('now') AND o.status != 'Cancelado'
       GROUP BY oi.product_id
       ORDER BY qty DESC
       LIMIT 5`
    )
    .all();

  const hourlyRows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COALESCE(SUM(total_cents), 0) AS revenue
       FROM orders
       WHERE date(created_at) = date('now') AND status != 'Cancelado'
       GROUP BY hour`
    )
    .all();
  const byHour = new Map(hourlyRows.map((r) => [r.hour, r.revenue / 100]));
  const salesByHour = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: byHour.get(hour) || 0 }));

  res.json({
    revenueToday: today.revenue / 100,
    ordersToday: today.orders,
    avgTicket: avgTicketCents / 100,
    topProducts,
    salesByHour,
  });
});

// Métricas de operação: calculadas de verdade a partir do histórico de status
// (order_status_log), não valores fixos como no protótipo original.
adminRouter.get("/ops-metrics", requireAuth, requireRole("admin"), (req, res) => {
  const logs = db
    .prepare(
      `SELECT osl.order_id AS orderId, osl.status, osl.changed_at AS changedAt
       FROM order_status_log osl
       JOIN orders o ON o.id = osl.order_id
       WHERE date(o.created_at) = date('now')
       ORDER BY osl.order_id, osl.changed_at`
    )
    .all();

  const byOrder = new Map();
  for (const log of logs) {
    if (!byOrder.has(log.orderId)) byOrder.set(log.orderId, []);
    byOrder.get(log.orderId).push(log);
  }

  const queueDurations = [];
  const prepDurations = [];
  for (const entries of byOrder.values()) {
    const at = (status) => entries.find((e) => e.status === status)?.changedAt;
    const naFila = at("Na Fila");
    const emPreparo = at("Em Preparo");
    const pronto = at("Pronto");
    if (naFila && emPreparo) {
      queueDurations.push((new Date(emPreparo + "Z") - new Date(naFila + "Z")) / 1000);
    }
    if (emPreparo && pronto) {
      prepDurations.push((new Date(pronto + "Z") - new Date(emPreparo + "Z")) / 1000);
    }
  }
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

  const openOrders = db
    .prepare(`SELECT id, status, updated_at AS updatedAt FROM orders WHERE status IN ('Na Fila','Em Preparo')`)
    .all();
  const LATE_THRESHOLD_SECONDS = 10 * 60;
  const lateOrders = openOrders.filter(
    (o) => (Date.now() - new Date(o.updatedAt + "Z").getTime()) / 1000 > LATE_THRESHOLD_SECONDS
  ).length;

  const cancelledToday = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE date(created_at) = date('now') AND status = 'Cancelado'`)
    .get().n;

  const soldOut = db
    .prepare(`SELECT name FROM products WHERE sold_out = 1`)
    .all();

  res.json({
    avgQueueSeconds: avg(queueDurations),
    avgPrepSeconds: avg(prepDurations),
    ordersInQueueOrPrep: openOrders.length,
    lateOrders,
    cancelledToday,
    soldOutProducts: soldOut.map((p) => p.name),
  });
});

// Encerrar o dia: gera de fato um relatório (o protótipo só ligava um booleano).
adminRouter.post("/close-day", requireAuth, requireRole("admin"), (req, res) => {
  const settings = db.prepare("SELECT * FROM kiosk_settings WHERE id = 1").get();
  if (settings.day_closed) {
    return res.status(409).json({ error: "O dia já está encerrado." });
  }

  const today = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue
       FROM orders WHERE date(created_at) = date('now') AND status != 'Cancelado'`
    )
    .get();
  const avgTicketCents = today.orders > 0 ? Math.round(today.revenue / today.orders) : 0;
  const topProducts = db
    .prepare(
      `SELECT oi.product_name_snapshot AS name, SUM(oi.qty) AS qty
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE date(o.created_at) = date('now') AND o.status != 'Cancelado'
       GROUP BY oi.product_id ORDER BY qty DESC LIMIT 5`
    )
    .all();

  const info = db
    .prepare(
      `INSERT INTO day_reports (total_revenue_cents, total_orders, avg_ticket_cents, top_products_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(today.revenue, today.orders, avgTicketCents, JSON.stringify(topProducts));
  db.prepare("UPDATE kiosk_settings SET day_closed = 1 WHERE id = 1").run();

  const report = db.prepare("SELECT * FROM day_reports WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({
    id: report.id,
    closedAt: report.closed_at,
    totalRevenue: report.total_revenue_cents / 100,
    totalOrders: report.total_orders,
    avgTicket: report.avg_ticket_cents / 100,
    topProducts: JSON.parse(report.top_products_json),
  });
});

adminRouter.get("/day-reports/latest", requireAuth, requireRole("admin"), (req, res) => {
  const report = db.prepare("SELECT * FROM day_reports ORDER BY id DESC LIMIT 1").get();
  if (!report) return res.status(404).json({ error: "Nenhum relatório ainda." });
  res.json({
    id: report.id,
    closedAt: report.closed_at,
    totalRevenue: report.total_revenue_cents / 100,
    totalOrders: report.total_orders,
    avgTicket: report.avg_ticket_cents / 100,
    topProducts: JSON.parse(report.top_products_json),
  });
});

adminRouter.post("/reopen-day", requireAuth, requireRole("admin"), (req, res) => {
  db.prepare("UPDATE kiosk_settings SET day_closed = 0 WHERE id = 1").run();
  res.json({ dayClosed: false });
});
