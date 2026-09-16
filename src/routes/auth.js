import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db } from "../db.js";
import { signToken } from "../middleware/auth.js";
import { loginSchema, validate } from "../validation/schemas.js";

export const authRouter = Router();

// Trava força bruta: no máximo 10 tentativas por IP a cada 15 minutos nesta rota.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Tente novamente mais tarde." },
});

authRouter.post("/login", loginLimiter, validate(loginSchema), (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());

  // Mesma mensagem genérica para e-mail inexistente e senha errada — evita
  // que um atacante descubra quais e-mails existem na base (user enumeration).
  const invalid = () => res.status(401).json({ error: "Credenciais inválidas." });

  if (!user) return invalid();
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return invalid();

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});
