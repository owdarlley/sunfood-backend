import { supabaseAuth, supabaseAdmin } from "../supabase.js";

// O token que chega aqui é o access_token emitido pelo próprio Supabase Auth
// no login (não é mais assinado por nós) — validá-lo é perguntar ao GoTrue
// se ele é genuíno e ainda válido, não verificar uma assinatura local.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Token ausente." });
  }

  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role, name, phone, birth_date, terms_accepted_at")
    .eq("id", userData.user.id)
    .single();
  if (profileError || !profile) {
    return res.status(401).json({ error: "Perfil não encontrado." });
  }

  req.user = {
    sub: userData.user.id,
    email: userData.user.email,
    name: profile.name,
    role: profile.role,
    profileComplete: isProfileComplete(profile),
  };
  next();
}

// Quem entra pelo Google não passa pelo formulário de cadastro: chega sem
// telefone, sem data de nascimento (idade mínima, o cardápio tem bebida
// alcoólica) e sem ter aceitado os termos. Equipe (admin/cozinha) não pede.
export function isProfileComplete(profile) {
  if (!profile || profile.role !== "cliente") return true;
  return Boolean(profile.phone && profile.birth_date && profile.terms_accepted_at);
}

// Cliente só faz pedido com o cadastro completo (ver isProfileComplete).
export function requireCompleteProfile(req, res, next) {
  if (req.user?.profileComplete) return next();
  return res.status(403).json({
    error: "Complete seu cadastro (telefone, data de nascimento e termos) antes de fazer pedidos.",
    code: "profile_incomplete",
  });
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Sem permissão para este recurso." });
    }
    next();
  };
}
