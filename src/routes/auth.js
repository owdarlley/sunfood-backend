import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth, supabaseAdmin } from "../supabase.js";
import { requireAuth, isProfileComplete } from "../middleware/auth.js";
import { maskEmail } from "../mask-email.js";
import {
  loginSchema,
  signupSchema,
  forgotPasswordSchema,
  resendConfirmationSchema,
  refreshSchema,
  updatePasswordSchema,
  completeProfileSchema,
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

// Um CPF por conta: evita que a mesma pessoa abra várias contas, ou use o
// CPF de outra. O banco também garante isso (índice único em profiles.cpf).
const CPF_TAKEN = "Este CPF já está cadastrado em outra conta.";

async function cpfTaken(cpf, exceptUserId) {
  const { data } = await supabaseAdmin.from("profiles").select("id").eq("cpf", cpf).maybeSingle();
  return Boolean(data && data.id !== exceptUserId);
}

authRouter.post("/login", loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  // Mesma mensagem genérica pra e-mail inexistente e senha errada — evita
  // que um atacante descubra quais e-mails existem na base (user enumeration).
  // O Supabase só responde "email_not_confirmed" quando a senha está certa,
  // então avisar isso não revela nada pra quem está chutando senhas — e
  // evita que o cliente ache que errou a senha quando só falta confirmar.
  if (error?.code === "email_not_confirmed") {
    return res.status(403).json({
      error: "Confirme seu e-mail antes de entrar. Procure o e-mail do Sunfood na caixa de entrada ou no spam.",
      code: "email_not_confirmed",
    });
  }
  if (error || !data.session) {
    return res.status(401).json({ error: "Credenciais inválidas." });
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, name, phone, cpf, birth_date, terms_accepted_at")
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
      profileComplete: isProfileComplete(profile),
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
  const { name, email, password, phone, cpf, birthDate, termsAccepted } = req.body;
  if (await cpfTaken(cpf)) return res.status(400).json({ error: CPF_TAKEN });
  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
        phone,
        cpf,
        birth_date: birthDate,
        // Registra quando o aceite aconteceu, não só que aconteceu — evidência
        // de consentimento de verdade (LGPD), não um checkbox decorativo.
        terms_accepted_at: termsAccepted ? new Date().toISOString() : null,
      },
      emailRedirectTo: process.env.EMAIL_CONFIRM_REDIRECT_URL,
    },
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

// Reenvia o e-mail de confirmação de cadastro (o link expira, cai no spam...).
// Sempre responde OK, exista ou não a conta, pelo mesmo motivo do
// forgot-password: não vazar quais e-mails têm cadastro.
authRouter.post("/resend-confirmation", forgotLimiter, validate(resendConfirmationSchema), async (req, res) => {
  await supabaseAuth.auth.resend({
    type: "signup",
    email: req.body.email,
    options: { emailRedirectTo: process.env.EMAIL_CONFIRM_REDIRECT_URL },
  });
  res.json({ message: "Se esse e-mail estiver aguardando confirmação, enviamos um novo link." });
});

// Recuperação de senha de verdade — dispara o e-mail que o Supabase Auth
// envia (link assinado, expira sozinho). Avisa quando o e-mail não tem conta
// (pedido do dono: o cliente precisa saber que digitou errado) ou quando a
// conta só entra pelo Google e não tem senha. O cadastro já revela se um
// e-mail existe, então isso não abre nada novo; o forgotLimiter segura
// quem tentar testar e-mails em massa.
// Também aceita o CPF, pra quem não lembra o e-mail do cadastro: o link vai
// pro e-mail da conta e a resposta mostra esse e-mail mascarado
// (d*****7@gmail.com), só o bastante pro cliente saber onde procurar.
authRouter.post("/forgot-password", forgotLimiter, validate(forgotPasswordSchema), async (req, res) => {
  const byCpf = !req.body.email;
  const { data: profile } = byCpf
    ? await supabaseAdmin.from("profiles").select("id, email").eq("cpf", req.body.cpf).maybeSingle()
    : await supabaseAdmin.from("profiles").select("id, email").eq("email", req.body.email.toLowerCase()).maybeSingle();
  if (!profile?.email) {
    return res.status(404).json(
      byCpf
        ? { error: "Não encontramos uma conta com este CPF. Confira os números ou crie uma conta.", code: "cpf_not_found" }
        : { error: "Não encontramos uma conta com este e-mail. Confira se digitou certo ou crie uma conta.", code: "email_not_found" },
    );
  }
  const email = profile.email.toLowerCase();
  const { data: found } = await supabaseAdmin.auth.admin.getUserById(profile.id);
  const providers = found?.user?.app_metadata?.providers || [];
  if (providers.length && !providers.includes("email")) {
    return res.status(400).json({
      error: "Esta conta foi criada com o Google e não tem senha. Use o botão \"Entrar com Google\".",
      code: "google_account",
      ...(byCpf && { sentTo: maskEmail(email) }),
    });
  }
  const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
    redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL,
  });
  if (error) return res.status(502).json({ error: "Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos." });
  if (byCpf) {
    const sentTo = maskEmail(email);
    return res.json({ message: `Enviamos um link de redefinição para ${sentTo}.`, sentTo });
  }
  res.json({ message: "Enviamos um link de redefinição para o seu e-mail." });
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

// "Quem sou eu" — usado depois do login social (Google), que devolve o
// access_token direto pro navegador (redirect do Supabase) sem passar pelo
// nosso /auth/login. O front troca esse token pelos dados do perfil aqui.
authRouter.get("/me", requireAuth, async (req, res) => {
  const { sub: id, name, email, role, profileComplete } = req.user;
  res.json({ user: { id, name, email, role, profileComplete } });
});

// Quem entrou pelo Google completa aqui o que o formulário de cadastro
// pediria: telefone, CPF, data de nascimento (18+) e aceite dos termos (LGPD).
authRouter.post("/complete-profile", requireAuth, validate(completeProfileSchema), async (req, res) => {
  const { name, phone, cpf, birthDate } = req.body;
  if (await cpfTaken(cpf, req.user.sub)) return res.status(409).json({ error: CPF_TAKEN });
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ name, phone, cpf, birth_date: birthDate, terms_accepted_at: new Date().toISOString() })
    .eq("id", req.user.sub);
  // 23505 = o índice único do banco barrou (dois cadastros ao mesmo tempo com o mesmo CPF).
  if (error?.code === "23505") return res.status(409).json({ error: CPF_TAKEN });
  if (error) return res.status(500).json({ error: "Não foi possível salvar seu cadastro." });
  const { sub: id, email, role } = req.user;
  res.json({ user: { id, name, email, role, profileComplete: true } });
});

// Exclusão da própria conta (LGPD, direito de eliminação) — a tela já
// existia no protótipo, mas não apagava nada de verdade.
authRouter.post("/delete-account", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.sub);
  if (error) return res.status(500).json({ error: "Não foi possível excluir a conta." });
  res.json({ message: "Conta excluída." });
});
