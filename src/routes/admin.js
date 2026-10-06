import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { cancelWindowFrom, minOrderCentsFrom, tableCountFrom } from "../business-rules.js";
import {
  kioskPauseSchema,
  kioskCancelWindowSchema,
  kioskMinOrderSchema,
  kioskTableCountSchema,
  salesReportQuerySchema,
  REPORT_PERIODS,
  validate,
} from "../validation/schemas.js";

export const adminRouter = Router();

function kioskToApi(row) {
  return {
    paused: !!row.paused,
    dayClosed: !!row.day_closed,
    cancelWindowMinutes: cancelWindowFrom(row),
    minOrder: minOrderCentsFrom(row) / 100,
    tableCount: tableCountFrom(row),
  };
}

adminRouter.get("/kiosk-settings", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single();
  if (error) return res.status(500).json({ error: "Erro ao carregar configurações do quiosque." });
  res.json(kioskToApi(data));
});

adminRouter.patch(
  "/kiosk-settings/pause",
  requireAuth,
  requireRole("admin"),
  validate(kioskPauseSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("kiosk_settings")
      .update({ paused: req.body.paused })
      .eq("id", 1)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "Não foi possível atualizar o quiosque." });
    res.json(kioskToApi(data));
  }
);

// Admin: quantos minutos o cliente tem pra cancelar depois de fazer o pedido.
adminRouter.patch(
  "/kiosk-settings/cancel-window",
  requireAuth,
  requireRole("admin"),
  validate(kioskCancelWindowSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("kiosk_settings")
      .update({ cancel_window_minutes: req.body.minutes })
      .eq("id", 1)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "Não foi possível salvar o prazo de cancelamento." });
    res.json(kioskToApi(data));
  }
);

adminRouter.patch(
  "/kiosk-settings/min-order",
  requireAuth,
  requireRole("admin"),
  validate(kioskMinOrderSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("kiosk_settings")
      .update({ min_order_cents: Math.round(req.body.minOrder * 100) })
      .eq("id", 1)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "Não foi possível salvar o pedido mínimo." });
    res.json(kioskToApi(data));
  }
);

// Admin: quantas mesas o quiosque tem. A função do banco cria as mesas que
// faltam e apaga as que sobram (as que já tiveram pedido ficam no histórico).
adminRouter.patch(
  "/kiosk-settings/table-count",
  requireAuth,
  requireRole("admin"),
  validate(kioskTableCountSchema),
  async (req, res) => {
    const { error: rpcError } = await supabaseAdmin.rpc("set_table_count", { p_count: req.body.count });
    if (rpcError) return res.status(500).json({ error: "Não foi possível salvar a quantidade de mesas." });
    const { data, error } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single();
    if (error) return res.status(500).json({ error: "Não foi possível salvar a quantidade de mesas." });
    res.json(kioskToApi(data));
  }
);

// Dashboard: agregação real via RPC (public.dashboard_stats) — substitui os
// KPIs mockados do protótipo, que eram sempre os mesmos números fixos.
adminRouter.get("/dashboard", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc("dashboard_stats");
  if (error) return res.status(500).json({ error: "Erro ao calcular o dashboard." });
  res.json({
    revenueToday: Number(data.revenueToday),
    ordersToday: data.ordersToday,
    avgTicket: Number(data.avgTicket),
    topProducts: data.topProducts,
    salesByHour: data.salesByHour,
  });
});

// Relatórios: vendas, mais vendidos e horários de pico no período escolhido
// (hoje, 7 ou 30 dias). Só conta pedido pago ou "pagar na entrega", sem
// cancelados nem estornados — a conta toda é feita no banco (sales_report).
adminRouter.get(
  "/reports/sales",
  requireAuth,
  requireRole("admin"),
  validate(salesReportQuerySchema, "query"),
  async (req, res) => {
    const period = req.query.period || "hoje";
    const { data, error } = await supabaseAdmin.rpc("sales_report", { p_days: REPORT_PERIODS[period] });
    if (error) return res.status(500).json({ error: "Erro ao gerar o relatório." });
    res.json({
      period,
      from: data.from,
      to: data.to,
      revenue: Number(data.revenue),
      orders: data.orders,
      avgTicket: Number(data.avgTicket),
      itemsSold: Number(data.itemsSold),
      topProducts: data.topProducts.map((p) => ({ name: p.name, qty: Number(p.qty), revenue: Number(p.revenue) })),
      byHour: data.byHour.map((h) => ({ hour: h.hour, orders: h.orders, revenue: Number(h.revenue) })),
      byDay: data.byDay.map((d) => ({ date: d.date, orders: d.orders, revenue: Number(d.revenue) })),
    });
  }
);

// Métricas de operação: calculadas de verdade a partir do histórico de status
// (order_status_log), não valores fixos como no protótipo original.
adminRouter.get("/ops-metrics", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc("ops_metrics");
  if (error) return res.status(500).json({ error: "Erro ao calcular métricas de operação." });
  res.json(data);
});

// Encerrar o dia: gera de fato um relatório (o protótipo só ligava um booleano).
adminRouter.post("/close-day", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc("close_day");
  if (error) {
    if (error.message?.includes("day_already_closed")) {
      return res.status(409).json({ error: "O dia já está encerrado." });
    }
    return res.status(500).json({ error: "Não foi possível encerrar o dia." });
  }
  res.status(201).json(data);
});

adminRouter.get("/day-reports/latest", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("day_reports")
    .select("*")
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Erro ao carregar relatório." });
  if (!data) return res.status(404).json({ error: "Nenhum relatório ainda." });
  res.json({
    id: data.id,
    closedAt: data.closed_at,
    totalRevenue: Number(data.total_revenue),
    totalOrders: data.total_orders,
    avgTicket: Number(data.avg_ticket),
    topProducts: data.top_products,
  });
});

adminRouter.post("/reopen-day", requireAuth, requireRole("admin"), async (req, res) => {
  const { error } = await supabaseAdmin.from("kiosk_settings").update({ day_closed: false }).eq("id", 1);
  if (error) return res.status(500).json({ error: "Não foi possível reabrir o dia." });
  res.json({ dayClosed: false });
});
