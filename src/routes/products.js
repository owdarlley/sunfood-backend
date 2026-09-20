import { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
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
    price: Number(row.price),
    soldOut: row.sold_out,
    portion: row.portion,
    prepTime: row.prep_time,
    kcal: row.kcal,
    rating: row.rating,
    reviewCount: row.review_count,
    ingredients: row.ingredients,
    imageKey: row.mark,
    tags: row.tags || [],
  };
}

function fromApi(p) {
  return {
    name: p.name,
    description: p.description,
    long_description: p.longDescription,
    category: p.category,
    price: p.price,
    portion: p.portion,
    prep_time: p.prepTime,
  };
}

// Público: cardápio do cliente.
productsRouter.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .order("category")
    .order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar cardápio." });
  res.json(data.map(toApi));
});

// Admin: criar produto novo (corrige o savePf() do protótipo, que nunca persistia).
productsRouter.post("/", requireAuth, requireRole("admin"), validate(productSchema), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .insert(fromApi(req.body))
    .select()
    .single();
  if (error) return res.status(500).json({ error: "Não foi possível criar o produto." });
  res.status(201).json(toApi(data));
});

// Admin: editar produto existente.
productsRouter.put("/:id", requireAuth, requireRole("admin"), validate(productSchema), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .update(fromApi(req.body))
    .eq("id", req.params.id)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(toApi(data));
});

// Cozinha (ou admin): sinalizar item indisponível / disponível de novo.
productsRouter.patch(
  "/:id/sold-out",
  requireAuth,
  requireRole("admin", "cozinha"),
  validate(soldOutToggleSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("products")
      .update({ sold_out: req.body.soldOut })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
    res.json(toApi(data));
  }
);
