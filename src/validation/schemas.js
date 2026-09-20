import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().email("E-mail inválido."),
  password: z.string().min(4, "Senha muito curta."),
});

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Nome muito curto.").max(120),
  email: z.string().trim().email("E-mail inválido."),
  password: z.string().min(6, "Senha deve ter ao menos 6 caracteres."),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email("E-mail inválido."),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, "refreshToken inválido."),
});

export const updatePasswordSchema = z.object({
  accessToken: z.string().min(10, "Link de redefinição inválido."),
  newPassword: z.string().min(6, "Senha deve ter ao menos 6 caracteres."),
});

export const orderItemSchema = z.object({
  productId: z.string().uuid("Produto inválido."),
  qty: z.number().int().positive().max(50),
  note: z.string().trim().max(280).optional().default(""),
});

export const createOrderSchema = z.object({
  tableNumber: z.number().int().positive(),
  items: z.array(orderItemSchema).min(1, "O carrinho está vazio."),
  note: z.string().trim().max(280).optional().default(""),
});

export const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(280).optional().default(""),
  longDescription: z.string().trim().max(1000).optional().default(""),
  category: z.enum(["Bebidas", "Lanches", "Pratos", "Sobremesas"]),
  price: z.number().positive().max(10000),
  portion: z.string().trim().max(80).optional().default(""),
  prepTime: z.string().trim().max(40).optional().default(""),
});

export const tableToggleSchema = z.object({
  active: z.boolean(),
});

export const soldOutToggleSchema = z.object({
  soldOut: z.boolean(),
});

export const kioskPauseSchema = z.object({
  paused: z.boolean(),
});

export const orderStatusUpdateSchema = z.object({
  status: z.enum(["Em Preparo", "Pronto", "Entregue", "Cancelado"]),
});

export function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: "Dados inválidos.",
        details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    req[source] = result.data;
    next();
  };
}
