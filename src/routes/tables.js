import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { tableToggleSchema, validate } from "../validation/schemas.js";
import { tableCountFrom } from "../business-rules.js";

export const tablesRouter = Router();

function toApi(row) {
  return { number: row.number, active: row.active, seats: row.seats };
}

// Público: precisa ser lido tanto pelo cliente (validar mesa) quanto pelo admin.
// Só as mesas de 1 até a quantidade escolhida pelo admin.
tablesRouter.get("/", async (req, res) => {
  const [{ data, error }, { data: settings }] = await Promise.all([
    supabaseAdmin.from("kiosk_tables").select("*").order("number"),
    supabaseAdmin.from("kiosk_settings").select("*").eq("id", 1).single(),
  ]);
  if (error) return res.status(500).json({ error: "Erro ao carregar mesas." });
  const count = tableCountFrom(settings);
  res.json(data.filter((t) => t.number <= count).map(toApi));
});

tablesRouter.patch(
  "/:number/active",
  requireAuth,
  requireRole("admin"),
  validate(tableToggleSchema),
  async (req, res) => {
    const number = Number(req.params.number);
    const { data, error } = await supabaseAdmin
      .from("kiosk_tables")
      .update({ active: req.body.active })
      .eq("number", number)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: "Mesa não encontrada." });
    res.json(toApi(data));
  }
);
