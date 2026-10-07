import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomInt } from "node:crypto";
import { supabaseAdmin } from "../supabase.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sendEmail, emailConfigured } from "../email.js";
import { contactReplyEmail } from "../emails/resposta-contato.js";
import {
  contactMessageSchema,
  contactReplySchema,
  contactStatusSchema,
  isEmailContact,
  validate,
} from "../validation/schemas.js";

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
    reply: row.reply ?? null,
    replyChannel: row.reply_channel ?? null,
    repliedAt: row.replied_at ?? null,
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

// Admin: responde a mensagem. Se o contato é e-mail, a API manda a resposta
// por e-mail (Resend) e só grava depois que o envio deu certo. Se é telefone,
// o app abre o WhatsApp com o texto pronto e aqui só fica registrado.
contactRouter.post(
  "/:id/reply",
  requireAuth,
  requireRole("admin"),
  validate(contactReplySchema),
  async (req, res) => {
    const { data: msg } = await supabaseAdmin
      .from("contact_messages")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!msg) return res.status(404).json({ error: "Mensagem não encontrada." });

    const channel = isEmailContact(msg.contact) ? "email" : "whatsapp";
    if (channel === "email") {
      if (!emailConfigured()) {
        return res.status(503).json({
          error: "O envio de e-mail ainda não foi configurado no servidor. A resposta não foi enviada.",
          code: "email_not_configured",
        });
      }
      try {
        const mail = contactReplyEmail({ ...msg, reply: req.body.reply });
        await sendEmail({ to: msg.contact.trim(), ...mail, replyTo: process.env.CONTACT_REPLY_TO || undefined });
      } catch (err) {
        console.error("Falha ao enviar resposta do Fale conosco:", err.message);
        return res.status(502).json({ error: "Não foi possível enviar o e-mail agora. Tente de novo em instantes." });
      }
    }

    const { data, error } = await supabaseAdmin
      .from("contact_messages")
      .update({
        reply: req.body.reply,
        reply_channel: channel,
        replied_at: new Date().toISOString(),
        status: "respondido",
      })
      .eq("id", msg.id)
      .select()
      .single();
    if (error || !data) {
      // O e-mail já saiu; só o registro falhou. Avisa sem sugerir reenviar.
      return res.status(500).json({ error: "A resposta foi enviada, mas não deu para salvar no histórico." });
    }
    res.json(toApi(data));
  }
);
