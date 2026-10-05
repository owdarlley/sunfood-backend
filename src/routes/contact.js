import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomInt } from "node:crypto";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { contactMessageSchema, contactStatusSchema, validate } from "../validation/schemas.js";

export const contactRouter = Router();

// Formulário público: segura spam sem travar quem manda uma ou duas mensagens.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas mensagens em pouco tempo. Tente novamente mais tarde." },
});

function toApi(row) {
  return {
    id: row.id,
    protocol: row.protocol,
    name: row.name,
    contact: row.contact,
    reason: row.reason,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Público: "Fale conosco" do site grava a mensagem e devolve o protocolo.
contactRouter.post("/", contactLimiter, validate(contactMessageSchema), async (req, res) => {
  // Protocolo curto pra pessoa anotar; se colidir (unique), tenta de novo.
  for (let attempt = 0; attempt < 3; attempt++) {
    const protocol = "SF-" + randomInt(100000, 1000000);
    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .insert({ ...req.body, protocol })
      .select()
      .single();
    if (!error && data) return res.status(201).json({ protocol: data.protocol });
    if (error?.code !== "23505") break;
  }
  res.status(500).json({ error: "Não foi possível enviar sua mensagem. Tente novamente." });
});

// Admin: caixa de entrada, mais novas primeiro.
contactRouter.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: "Erro ao carregar mensagens." });
  res.json(data.map(toApi));
});

// Admin: marca como respondida (ou volta pra nova).
contactRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("admin"),
  validate(contactStatusSchema),
  async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .update({ status: req.body.status })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: "Mensagem não encontrada." });
    res.json(toApi(data));
  }
);
