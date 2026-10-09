import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  REPORT_PERIODS,
  salesReportQuerySchema,
  waiterActiveSchema,
  waiterCreateSchema,
  validate,
} from "../validation/schemas.js";

export const waitersRouter = Router();

// Conta desativada = bloqueada no Supabase Auth (não entra mais), sem apagar
// nada: os pedidos que o garçom lançou e entregou continuam nas métricas.
const BAN_FOREVER = "876000h"; // ~100 anos

const isBanned = (authUser) => Boolean(authUser?.banned_until && new Date(authUser.banned_until) > new Date());

function metricsToApi(period, data) {
  return {
    period,
    from: data.from,
    to: data.to,
    delivered: Number(data.delivered),
    avgDeliverMin: Number(data.avgDeliverMin),
    launched: Number(data.launched),
    launchedTotal: Number(data.launchedTotal),
    received: Number(data.received),
    byDay: (data.byDay || []).map((d) => ({ date: d.date, delivered: Number(d.delivered), launched: Number(d.launched) })),
  };
}

// Garçom: as próprias métricas no período (hoje, 7 ou 30 dias).
waitersRouter.get(
  "/waiter/metrics",
  requireAuth,
  requireRole("garcom"),
  validate(salesReportQuerySchema, "query"),
  async (req, res) => {
    const period = req.query.period || "hoje";
    const { data, error } = await supabaseAdmin.rpc("waiter_metrics", { p_waiter: req.user.sub, p_days: REPORT_PERIODS[period] });
    if (error) return res.status(500).json({ error: "Erro ao calcular suas métricas." });
    res.json(metricsToApi(period, data));
  }
);

// Admin: lista dos garçons, com o que cada um fez hoje.
waitersRouter.get("/waiters", requireAuth, requireRole("admin"), async (req, res) => {
  const { data: rows, error } = await supabaseAdmin
    .from("profiles")
    .select("id, name, email, created_at")
    .eq("role", "garcom")
    .order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar os garçons." });
  const waiters = await Promise.all(
    rows.map(async (row) => {
      const [{ data: found }, { data: today }] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(row.id),
        supabaseAdmin.rpc("waiter_metrics", { p_waiter: row.id, p_days: 1 }),
      ]);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        createdAt: row.created_at,
        active: !isBanned(found?.user),
        deliveredToday: Number(today?.delivered || 0),
        launchedToday: Number(today?.launched || 0),
      };
    })
  );
  res.json(waiters);
});

// Admin: cria a conta de um garçom. O e-mail já sai confirmado (quem cadastra
// é o quiosque) e o papel vira "garcom" logo depois que o banco cria o perfil.
waitersRouter.post("/waiters", requireAuth, requireRole("admin"), validate(waiterCreateSchema), async (req, res) => {
  const { name, email, password } = req.body;
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error || !data?.user) {
    if (error?.code === "email_exists" || /already (been )?registered|already exists/i.test(error?.message || "")) {
      return res.status(409).json({ error: "Já existe uma conta com esse e-mail." });
    }
    if (error?.code === "weak_password") {
      return res.status(400).json({ error: "Senha fraca. Use pelo menos 6 caracteres, misturando letras e números." });
    }
    return res.status(500).json({ error: "Não foi possível criar a conta do garçom." });
  }
  const { error: roleError } = await supabaseAdmin
    .from("profiles")
    .update({ role: "garcom", name })
    .eq("id", data.user.id);
  if (roleError) {
    // Sem o papel certo a conta entraria como cliente: desfaz a criação.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    return res.status(500).json({ error: "Não foi possível criar a conta do garçom." });
  }
  res.status(201).json({ id: data.user.id, name, email, active: true, deliveredToday: 0, launchedToday: 0 });
});

// Admin: desativa (não entra mais) ou reativa um garçom.
waitersRouter.patch("/waiters/:id", requireAuth, requireRole("admin"), validate(waiterActiveSchema), async (req, res) => {
  const { data: row } = await supabaseAdmin.from("profiles").select("id, role").eq("id", req.params.id).maybeSingle();
  if (!row || row.role !== "garcom") return res.status(404).json({ error: "Garçom não encontrado." });
  const { active } = req.body;
  const { error } = await supabaseAdmin.auth.admin.updateUserById(row.id, { ban_duration: active ? "none" : BAN_FOREVER });
  if (error) return res.status(500).json({ error: "Não foi possível salvar." });
  res.json({ id: row.id, active });
});
