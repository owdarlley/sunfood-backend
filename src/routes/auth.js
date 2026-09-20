import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth, supabaseAdmin } from "../supabase.js";
import { requireAuth } from "../middleware/auth.js";
import {
  loginSchema,
  signupSchema,
  forgotPasswordSchema,
  refreshSchema,
  updatePasswordSchema,
  validate,
} from "../validation/schemas.js";

export const authRouter = Router();

// Trava força bruta: no máximo 10 tentativas por IP a cada 15 minutos nesta rota.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Tente novamente mais tarde." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de cadastro. Tente novamente mais tarde." },
});

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas solicitações. Tente novamente mais tarde." },
});

authRouter.post("/login", loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  // Mesma mensagem genérica pra e-mail inexistente e senha errada — evita
  // que um atacante descubra quais e-mails existem na base (user enumeration).
  if (error || !data.session) {
    return res.status(401).json({ error: "Credenciais inválidas." });
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, name")
    .eq("id", data.user.id)
    .single();

  res.json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: {
      id: data.user.id,
      name: profile?.name || "",
      email: data.user.email,
      role: profile?.role || "cliente",
    },
  });
});

// Renova a sessão sem pedir senha de novo — o app chama isso quando uma
// requisição volta 401 por token expirado (access_token dura 1h por padrão).
authRouter.post("/refresh", validate(refreshSchema), async (req, res) => {
  const { data, error } = await supabaseAuth.auth.refreshSession({
    refresh_token: req.body.refreshToken,
  });
  if (error || !data.session) {
    return res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  }
  res.json({ token: data.session.access_token, refreshToken: data.session.refresh_token });
});

// Cadastro de verdade — antes era só uma tela decorativa que nunca criava
// conta nenhuma. Toda conta nova nasce como "cliente" (o trigger do banco
// cuida disso); virar admin/cozinha é decisão da administração, não do
// próprio cadastro.
authRouter.post("/signup", signupLimiter, validate(signupSchema), async (req, res) => {
  const { name, email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });

  if (error) {
    const jaExiste = /already registered|already exists/i.test(error.message || "");
    return res
      .status(400)
      .json({ error: jaExiste ? "Este e-mail já tem cadastro." : "Não foi possível criar a conta." });
  }

  res.status(201).json({
    requiresEmailConfirmation: !data.session,
    message: data.session
      ? "Conta criada."
      : "Conta criada — confira seu e-mail para confirmar antes de entrar.",
  });
});

// Recuperação de senha de verdade — dispara o e-mail que o Supabase Auth
// envia (link assinado, expira sozinho). Sempre responde OK, exista ou não
// o e-mail, pra não vazar quais contas existem.
authRouter.post("/forgot-password", forgotLimiter, validate(forgotPasswordSchema), async (req, res) => {
  const { email } = req.body;
  await supabaseAuth.auth.resetPasswordForEmail(email, {
    redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL,
  });
  res.json({ message: "Se esse e-mail tiver cadastro, enviamos um link de redefinição." });
});

// Segunda metade da recuperação de senha: o link do e-mail volta pro site
// com um access_token de recuperação na URL (#access_token=...&type=recovery,
// gerado pelo Supabase). A tela de redefinição manda esse token + a nova
// senha pra cá; validamos o token (garante que é um link de recuperação de
// verdade, não inventado) e trocamos a senha via Admin API.
authRouter.post("/update-password", forgotLimiter, validate(updatePasswordSchema), async (req, res) => {
  const { accessToken, newPassword } = req.body;
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Link de redefinição inválido ou expirado." });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userData.user.id, { password: newPassword });
  if (error) return res.status(500).json({ error: "Não foi possível redefinir a senha." });
  res.json({ message: "Senha redefinida com sucesso." });
});

// Exclusão da própria conta (LGPD, direito de eliminação) — a tela já
// existia no protótipo, mas não apagava nada de verdade.
authRouter.post("/delete-account", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.sub);
  if (error) return res.status(500).json({ error: "Não foi possível excluir a conta." });
  res.json({ message: "Conta excluída." });
});
