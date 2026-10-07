import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth, supabaseAdmin } from "../supabase.js";
import { requireAuth, isProfileComplete } from "../middleware/auth.js";
import { maskEmail } from "../mask-email.js";
import { MAX_IMAGE_BYTES, imageType, publicBucketPrefix } from "../images.js";
import {
  loginSchema,
  signupSchema,
  forgotPasswordSchema,
  resendConfirmationSchema,
  refreshSchema,
  updatePasswordSchema,
  completeProfileSchema,
  profileUpdateSchema,
  changePasswordSchema,
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

// Foto do perfil: bucket público "avatares"; o banco guarda só o nome do arquivo.
export const AVATARS_BUCKET = "avatares";
const PROFILE_COLUMNS = "role, name, phone, cpf, birth_date, terms_accepted_at, avatar_path, avatar_preset, notify_ready, sound_on";

const avatarUrl = (profile) => (profile?.avatar_path ? publicBucketPrefix(AVATARS_BUCKET) + profile.avatar_path : null);

// O que o app guarda do usuário logado (login, /me, salvar perfil).
function userApi(id, email, profile) {
  return {
    id,
    name: profile?.name || "",
    email,
    role: profile?.role || "cliente",
    profileComplete: isProfileComplete(profile),
    avatarUrl: avatarUrl(profile),
    avatarPreset: profile?.avatar_preset || null,
    notifyReady: profile?.notify_ready !== false,
    soundOn: profile?.sound_on !== false,
  };
}

// Só os 3 primeiros e os 2 últimos dígitos: o bastante pro dono reconhecer.
const maskCpf = (cpf) => (cpf ? `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}` : null);

async function hasPassword(userId) {
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  const providers = data?.user?.app_metadata?.providers || [];
  return !providers.length || providers.includes("email");
}

async function removeAvatarFile(path) {
  if (path) await supabaseAdmin.storage.from(AVATARS_BUCKET).remove([path]);
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
    .select(PROFILE_COLUMNS)
    .eq("id", data.user.id)
    .single();

  res.json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: userApi(data.user.id, data.user.email, profile),
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
  res.json({ user: userApi(req.user.sub, req.user.email, req.user.profile) });
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
  const profile = { ...req.user.profile, name, phone, cpf, birth_date: birthDate, terms_accepted_at: new Date().toISOString() };
  res.json({ user: userApi(req.user.sub, req.user.email, profile) });
});

// Tela Perfil: dados da conta pra preencher o formulário. O CPF vai mascarado
// (não muda por aqui) e hasPassword diz se a conta tem senha (quem entrou só
// pelo Google não tem, então o app esconde "Trocar senha").
authRouter.get("/profile", requireAuth, async (req, res) => {
  const p = req.user.profile;
  res.json({
    user: userApi(req.user.sub, req.user.email, p),
    phone: p.phone || "",
    birthDate: p.birth_date || "",
    cpf: maskCpf(p.cpf),
    hasPassword: await hasPassword(req.user.sub),
  });
});

// Salva o que o usuário mudou: nome, telefone, nascimento, avatar pronto e avisos.
authRouter.patch("/profile", requireAuth, validate(profileUpdateSchema), async (req, res) => {
  const { name, phone, birthDate, avatarPreset, notifyReady, soundOn } = req.body;
  const changes = {};
  if (name !== undefined) changes.name = name;
  if (phone !== undefined) changes.phone = phone;
  if (birthDate !== undefined) changes.birth_date = birthDate;
  if (notifyReady !== undefined) changes.notify_ready = notifyReady;
  if (soundOn !== undefined) changes.sound_on = soundOn;
  // Escolher um avatar pronto troca a foto enviada (e apaga o arquivo).
  if (avatarPreset !== undefined) {
    changes.avatar_preset = avatarPreset;
    if (avatarPreset) changes.avatar_path = null;
  }
  const { error } = await supabaseAdmin.from("profiles").update(changes).eq("id", req.user.sub);
  if (error) return res.status(500).json({ error: "Não foi possível salvar seu perfil." });
  const old = req.user.profile;
  if (changes.avatar_path === null && old.avatar_path) await removeAvatarFile(old.avatar_path);
  res.json({ user: userApi(req.user.sub, req.user.email, { ...old, ...changes }) });
});

// Trocar a senha logado, confirmando a senha atual (um celular esquecido
// desbloqueado não basta pra tomar a conta).
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Tente novamente mais tarde." },
});

authRouter.post("/change-password", changePasswordLimiter, requireAuth, validate(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await hasPassword(req.user.sub))) {
    return res.status(400).json({
      error: "Sua conta entra pelo Google e não tem senha no Sunfood.",
      code: "google_account",
    });
  }
  const { data, error: signInError } = await supabaseAuth.auth.signInWithPassword({
    email: req.user.email,
    password: currentPassword,
  });
  if (signInError || data?.user?.id !== req.user.sub) {
    return res.status(400).json({ error: "Senha atual incorreta.", code: "wrong_password" });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.sub, { password: newPassword });
  if (error) return res.status(500).json({ error: "Não foi possível trocar a senha." });
  res.json({ message: "Senha alterada." });
});

// Foto do perfil enviada pelo celular/computador (o app já reduz o tamanho).
authRouter.post(
  "/avatar",
  requireAuth,
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = imageType(buf);
    if (!type) return res.status(400).json({ error: "Envie uma foto em JPG, PNG ou WebP." });
    const path = `${randomUUID()}.${type.ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(AVATARS_BUCKET)
      .upload(path, buf, { contentType: type.mime, cacheControl: "31536000", upsert: false });
    if (upErr) return res.status(500).json({ error: "Não foi possível guardar a foto." });
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ avatar_path: path, avatar_preset: null })
      .eq("id", req.user.sub);
    if (error) {
      await removeAvatarFile(path);
      return res.status(500).json({ error: "Não foi possível salvar a foto." });
    }
    const old = req.user.profile;
    await removeAvatarFile(old.avatar_path);
    res.status(201).json({ user: userApi(req.user.sub, req.user.email, { ...old, avatar_path: path, avatar_preset: null }) });
  }
);

// Tira a foto e o avatar: volta pra inicial do nome.
authRouter.delete("/avatar", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ avatar_path: null, avatar_preset: null })
    .eq("id", req.user.sub);
  if (error) return res.status(500).json({ error: "Não foi possível tirar a foto." });
  const old = req.user.profile;
  await removeAvatarFile(old.avatar_path);
  res.json({ user: userApi(req.user.sub, req.user.email, { ...old, avatar_path: null, avatar_preset: null }) });
});

// Exclusão da própria conta (LGPD, direito de eliminação) — a tela já
// existia no protótipo, mas não apagava nada de verdade.
authRouter.post("/delete-account", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.sub);
  if (error) return res.status(500).json({ error: "Não foi possível excluir a conta." });
  await removeAvatarFile(req.user.profile.avatar_path);
  res.json({ message: "Conta excluída." });
});
