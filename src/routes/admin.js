import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { kioskPauseSchema, validate } from "../validation/schemas.js";

export const adminRouter = Router();

adminRouter.get("/kiosk-settings", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single();
  if (error) return res.status(500).json({ error: "Erro ao carregar configurações do quiosque." });
  res.json({ paused: !!data.paused, dayClosed: !!data.day_closed });
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
    res.json({ paused: !!data.paused, dayClosed: !!data.day_closed });
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
