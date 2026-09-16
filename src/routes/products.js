import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { productSchema, soldOutToggleSchema, validate } from "../validation/schemas.js";

export const productsRouter = Router();

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    longDescription: row.long_description,
    category: row.category,
    price: row.price_cents / 100,
    soldOut: !!row.sold_out,
    portion: row.portion,
    prepTime: row.prep_time,
    kcal: row.kcal,
    rating: row.rating,
    reviewCount: row.review_count,
    ingredients: row.ingredients,
    imageKey: row.image_key,
    tags: JSON.parse(row.tags_json || "[]"),
  };
}

// Público: cardápio do cliente.
productsRouter.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY category, name").all();
  res.json(rows.map(toApi));
});

// Admin: criar produto novo (corrige o savePf() do protótipo, que nunca persistia).
productsRouter.post("/", requireAuth, requireRole("admin"), validate(productSchema), (req, res) => {
  const p = req.body;
  const info = db
    .prepare(
      `INSERT INTO products (name, description, long_description, category, price_cents, portion, prep_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.name, p.description, p.longDescription, p.category, Math.round(p.price * 100), p.portion, p.prepTime);
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(toApi(row));
});

// Admin: editar produto existente.
productsRouter.put("/:id", requireAuth, requireRole("admin"), validate(productSchema), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Produto não encontrado." });
  const p = req.body;
  db.prepare(
    `UPDATE products SET name=?, description=?, long_description=?, category=?, price_cents=?,
       portion=?, prep_time=?, updated_at=datetime('now') WHERE id=?`
  ).run(p.name, p.description, p.longDescription, p.category, Math.round(p.price * 100), p.portion, p.prepTime, id);
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.json(toApi(row));
});

// Cozinha (ou admin): sinalizar item indisponível / disponível de novo.
productsRouter.patch(
  "/:id/sold-out",
  requireAuth,
  requireRole("admin", "cozinha"),
  validate(soldOutToggleSchema),
  (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Produto não encontrado." });
    db.prepare("UPDATE products SET sold_out = ?, updated_at = datetime('now') WHERE id = ?").run(
      req.body.soldOut ? 1 : 0,
      id
    );
    const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    res.json(toApi(row));
  }
);
