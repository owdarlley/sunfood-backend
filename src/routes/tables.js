import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { tableToggleSchema, validate } from "../validation/schemas.js";

export const tablesRouter = Router();

function toApi(row) {
  return { number: row.number, active: !!row.active, seats: row.seats };
}

// Público: precisa ser lido tanto pelo cliente (validar mesa) quanto pelo admin.
tablesRouter.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM tables ORDER BY number").all();
  res.json(rows.map(toApi));
});

tablesRouter.patch(
  "/:number/active",
  requireAuth,
  requireRole("admin"),
  validate(tableToggleSchema),
  (req, res) => {
    const number = Number(req.params.number);
    const existing = db.prepare("SELECT number FROM tables WHERE number = ?").get(number);
    if (!existing) return res.status(404).json({ error: "Mesa não encontrada." });
    db.prepare("UPDATE tables SET active = ? WHERE number = ?").run(req.body.active ? 1 : 0, number);
    const row = db.prepare("SELECT * FROM tables WHERE number = ?").get(number);
    res.json(toApi(row));
  }
);
