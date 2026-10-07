import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { MAX_IMAGE_BYTES, imageType, publicBucketPrefix } from "../images.js";
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
    // Esgotado "de fato" é o sinal manual (cozinha/admin) OU o estoque
    // controlado ter zerado — quem consome essa API não precisa saber qual
    // dos dois motivos foi.
    soldOut: row.sold_out || (row.stock_qty !== null && row.stock_qty <= 0),
    stockQty: row.stock_qty,
    portion: row.portion,
    prepTime: row.prep_time,
    kcal: row.kcal,
    rating: row.rating,
    reviewCount: row.review_count,
    ingredients: row.ingredients,
    imageKey: row.mark,
    imageUrl: row.image_url || null,
    tags: row.tags || [],
  };
}

function fromApi(p) {
  const row = {
    name: p.name,
    description: p.description,
    long_description: p.longDescription,
    category: p.category,
    price: p.price,
    portion: p.portion,
    prep_time: p.prepTime,
  };
  // Só grava o estoque quando ele veio no corpo: editar nome/preço não pode
  // sobrescrever o saldo com um valor velho (pedidos feitos enquanto o
  // formulário estava aberto seriam "desfeitos").
  if (p.stockQty !== undefined) row.stock_qty = p.stockQty;
  // Mesma ideia: ausente = mantém a foto; null = tira a foto.
  if (p.imageUrl !== undefined) row.image_url = p.imageUrl;
  return row;
}

// Fotos dos produtos ficam no Storage do Supabase, num bucket público (o
// cardápio mostra sem login). Só esta API grava nele, com a service role,
// depois de conferir que quem enviou é admin.
export const PRODUCT_IMAGES_BUCKET = "produtos";
function publicImagePrefix() {
  return publicBucketPrefix(PRODUCT_IMAGES_BUCKET);
}

// A foto só pode apontar pro nosso bucket: impede o admin (ou um token roubado)
// de colocar no cardápio uma imagem de um site qualquer.
function checkImageUrl(req, res, next) {
  const url = req.body.imageUrl;
  if (url != null && !url.startsWith(publicImagePrefix()))
    return res.status(400).json({ error: "Foto inválida. Envie a foto pelo botão do formulário." });
  next();
}

// Público: cardápio do cliente.
productsRouter.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .is("archived_at", null)
    .order("category")
    .order("name");
  if (error) return res.status(500).json({ error: "Erro ao carregar cardápio." });
  res.json(data.map(toApi));
});

// Admin: envia a foto (o navegador já reduz e comprime) e recebe o endereço
// público, que vai no imageUrl ao criar/editar o produto.
productsRouter.post(
  "/images",
  requireAuth,
  requireRole("admin"),
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = imageType(buf);
    if (!type) return res.status(400).json({ error: "Envie uma foto em JPG, PNG ou WebP." });
    const path = `${randomUUID()}.${type.ext}`;
    const { error } = await supabaseAdmin.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(path, buf, { contentType: type.mime, cacheControl: "31536000", upsert: false });
    if (error) return res.status(500).json({ error: "Não foi possível guardar a foto." });
    res.status(201).json({ url: publicImagePrefix() + path });
  }
);

// Admin: criar produto novo (corrige o savePf() do protótipo, que nunca persistia).
productsRouter.post("/", requireAuth, requireRole("admin"), validate(productSchema), checkImageUrl, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .insert(fromApi(req.body))
    .select()
    .single();
  if (error) return res.status(500).json({ error: "Não foi possível criar o produto." });
  res.status(201).json(toApi(data));
});

// Admin: editar produto existente.
productsRouter.put("/:id", requireAuth, requireRole("admin"), validate(productSchema), checkImageUrl, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .update(fromApi(req.body))
    .eq("id", req.params.id)
    .is("archived_at", null)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(toApi(data));
});

// Admin: excluir item do cardápio. Sem pedidos = apaga de vez (e a foto);
// com pedidos = arquiva, pra não estragar o histórico nem os relatórios.
productsRouter.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc("delete_or_archive_product", { p_id: req.params.id });
  if (error) {
    // id que não é UUID também cai aqui (o Postgres recusa o tipo).
    if (/product_not_found|invalid input syntax/.test(error.message || ""))
      return res.status(404).json({ error: "Produto não encontrado." });
    return res.status(500).json({ error: "Não foi possível excluir o produto." });
  }
  // A foto só sai do Storage quando o produto foi apagado de verdade. Se falhar,
  // o produto já sumiu; sobra só um arquivo solto, então não vira erro.
  if (data.action === "deleted" && data.imageUrl?.startsWith(publicImagePrefix())) {
    await supabaseAdmin.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .remove([data.imageUrl.slice(publicImagePrefix().length)])
      .catch(() => {});
  }
  res.json({ action: data.action });
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
      .is("archived_at", null)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: "Produto não encontrado." });
    res.json(toApi(data));
  }
);
