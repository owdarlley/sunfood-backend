import { z } from "zod";
import { MAX_CANCEL_WINDOW_MINUTES, MAX_TABLE_COUNT, PAYMENT_METHODS, RECEIVED_WITH } from "../business-rules.js";
import { isValidCpf, onlyDigits } from "./cpf.js";

export const loginSchema = z.object({
  email: z.string().trim().email("E-mail inválido."),
  password: z.string().min(4, "Senha muito curta."),
});

// Idade mínima pra cadastro — o cardápio vende bebida alcoólica
// (Caipirinha), então vender/servir pra menor de idade é crime (ECA, art.
// 243), não só uma regra de produto.
const MIN_AGE_YEARS = 18;

function hasMinAge(birthDateStr, minYears) {
  const birth = new Date(birthDateStr + "T00:00:00Z");
  if (Number.isNaN(birth.getTime())) return false;
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() - minYears);
  return birth.getTime() <= limit.getTime();
}

const nameField = z.string().trim().min(2, "Nome muito curto.").max(120);
const phoneField = z
  .string()
  .trim()
  .refine((v) => v.replace(/\D/g, "").length >= 10, "Telefone inválido.");
const birthDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data de nascimento inválida.")
  .refine((v) => hasMinAge(v, MIN_AGE_YEARS), `É preciso ter ${MIN_AGE_YEARS} anos ou mais para se cadastrar.`);
// Aceita com ou sem pontuação; grava só os 11 dígitos.
const cpfField = z
  .string()
  .trim()
  .refine(isValidCpf, "CPF inválido. Confira os números.")
  .transform(onlyDigits);
const termsField = z.literal(true, {
  message: "É preciso aceitar os termos de uso e a política de privacidade.",
});

export const signupSchema = z.object({
  name: nameField,
  email: z.string().trim().email("E-mail inválido."),
  password: z.string().min(6, "Senha deve ter ao menos 6 caracteres."),
  phone: phoneField,
  cpf: cpfField,
  birthDate: birthDateField,
  termsAccepted: termsField,
});

// Mesmos dados do cadastro, menos e-mail e senha — pra quem entrou pelo Google.
export const completeProfileSchema = z.object({
  name: nameField,
  phone: phoneField,
  cpf: cpfField,
  birthDate: birthDateField,
  termsAccepted: termsField,
});

// Avatares prontos do perfil (o app desenha cada um); o banco confere a mesma lista.
export const AVATAR_PRESETS = ["sol", "onda", "coco", "abacaxi", "peixe", "concha", "palmeira", "picole"];

// Tela Perfil: o usuário muda só o que mandar. E-mail e CPF não mudam aqui.
export const profileUpdateSchema = z
  .object({
    name: nameField.optional(),
    phone: phoneField.optional(),
    birthDate: birthDateField.optional(),
    avatarPreset: z.enum(AVATAR_PRESETS, { message: "Avatar inválido." }).nullable().optional(),
    notifyReady: z.boolean().optional(),
    soundOn: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "Nada para salvar." });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Digite sua senha atual."),
  newPassword: z.string().min(6, "Senha deve ter ao menos 6 caracteres."),
});

// Esqueci minha senha: o cliente manda o e-mail OU o CPF (pra quem não
// lembra com qual e-mail se cadastrou).
export const forgotPasswordSchema = z
  .object({
    email: z.string().trim().email("E-mail inválido.").optional(),
    cpf: cpfField.optional(),
  })
  .refine((d) => d.email || d.cpf, { message: "Informe seu e-mail ou CPF.", path: ["email"] });

export const resendConfirmationSchema = z.object({
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
  paymentMethod: z.enum(PAYMENT_METHODS).optional().default("pix"),
});

// null desfaz um recebimento marcado por engano.
export const paymentReceivedSchema = z.object({
  receivedWith: z.union([z.enum(RECEIVED_WITH), z.null()]),
});

export const cardCheckoutSchema = z.object({
  returnUrl: z.string().url("Endereço de retorno inválido."),
});

export const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(280).optional().default(""),
  longDescription: z.string().trim().max(1000).optional().default(""),
  category: z.enum(["Bebidas", "Lanches", "Pratos", "Sobremesas"]),
  price: z.number().positive().max(10000),
  portion: z.string().trim().max(80).optional().default(""),
  prepTime: z.string().trim().max(40).optional().default(""),
  // null = estoque não controlado (ilimitado); ausente = não mexe no saldo.
  stockQty: z.union([z.number().int().min(0), z.null()]).optional(),
  // null = sem foto; ausente = não mexe na foto atual.
  imageUrl: z.union([z.string().url("Foto inválida.").max(500), z.null()]).optional(),
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

// Em reais (como os preços); 0 = sem pedido mínimo.
export const kioskMinOrderSchema = z.object({
  minOrder: z.number().min(0, "Valor não pode ser negativo.").max(1000, "Valor máximo é R$ 1.000,00."),
});

// Quantas mesas (guarda-sóis) o quiosque tem; numeradas de 1 até esse número.
export const kioskTableCountSchema = z.object({
  count: z
    .number({ invalid_type_error: "Digite a quantidade de mesas." })
    .int("Use um número inteiro de mesas.")
    .min(1, "O quiosque precisa ter pelo menos 1 mesa.")
    .max(MAX_TABLE_COUNT, `O máximo é ${MAX_TABLE_COUNT} mesas.`),
});

// Onde fica o quiosque: nome, endereço (vira o mapa e o link do Google Maps)
// e horário (opcional).
export const kioskLocationSchema = z.object({
  name: z.string({ required_error: "Digite o nome do local." }).trim().min(1, "Digite o nome do local.").max(80, "Nome com no máximo 80 letras."),
  address: z.string({ required_error: "Digite o endereço." }).trim().min(5, "Digite o endereço completo.").max(200, "Endereço com no máximo 200 letras."),
  hours: z.string().trim().max(120, "Horário com no máximo 120 letras.").optional().default(""),
});

// Minutos que o cliente tem pra cancelar depois de fazer o pedido; 0 = sem prazo.
export const kioskCancelWindowSchema = z.object({
  minutes: z
    .number()
    .int("Use um número inteiro de minutos.")
    .min(0, "Não pode ser negativo.")
    .max(MAX_CANCEL_WINDOW_MINUTES, `O máximo é ${MAX_CANCEL_WINDOW_MINUTES} minutos.`),
});

export const orderStatusUpdateSchema = z.object({
  status: z.enum(["Em Preparo", "Pronto", "Entregue", "Cancelado"]),
});

// Relatórios do admin: período em dias (hoje, últimos 7 ou últimos 30 dias).
export const REPORT_PERIODS = { hoje: 1, "7d": 7, "30d": 30 };
export const salesReportQuerySchema = z.object({
  period: z.enum(Object.keys(REPORT_PERIODS), { message: "Período inválido. Use hoje, 7d ou 30d." }).default("hoje"),
});

// "Fale conosco" do site (painel do login): o contato pode ser e-mail ou
// telefone. Os motivos são os mesmos do <select> do index.html do site.
export const CONTACT_REASONS = [
  "Reservar mesa ou guarda-sol",
  "Tirar dúvida sobre o cardápio",
  "Dúvida sobre pagamento",
  "Suporte com um pedido em andamento",
  "Parceria com meu quiosque",
];
export const contactMessageSchema = z.object({
  name: nameField,
  contact: z
    .string()
    .trim()
    .max(160)
    .refine(
      (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) || v.replace(/\D/g, "").length >= 10,
      "Informe um e-mail ou telefone com DDD."
    ),
  reason: z.enum(CONTACT_REASONS, { message: "Escolha um dos motivos da lista." }),
  message: z.string().trim().min(10, "Escreva ao menos 10 caracteres.").max(2000, "Mensagem muito longa."),
});
export const contactStatusSchema = z.object({
  status: z.enum(["novo", "respondido"]),
});
export const contactReplySchema = z.object({
  reply: z.string().trim().min(2, "Escreva a resposta.").max(4000, "Resposta muito longa."),
});
// Mesma regra do contactMessageSchema: o que não é e-mail é telefone.
export const isEmailContact = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v).trim());

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
