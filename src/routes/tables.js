import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { tableToggleSchema, validate } from "../validation/schemas.js";

export const tablesRouter = Router();

function toApi(row) {
  return { number: row.number, active: row.active, seats: row.seats };
}

// Público: precisa ser lido tanto pelo cliente (validar mesa) quanto pelo admin.
tablesRouter.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin.from("kiosk_tables").select("*").order("number");
  if (error) return res.status(500).json({ error: "Erro ao carregar mesas." });
  res.json(data.map(toApi));
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
