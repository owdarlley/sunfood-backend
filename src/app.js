import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { authRouter } from "./routes/auth.js";
import { productsRouter } from "./routes/products.js";
import { tablesRouter } from "./routes/tables.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";
import { paymentsRouter } from "./routes/payments.js";

// Aceita uma lista separada por vírgula (ex.: GitHub Pages + localhost ao
// mesmo tempo), não só uma origem única.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:8000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const app = express();
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Sem header Origin (curl, apps nativos, o próprio webhook do Mercado
      // Pago) — permite; navegadores sempre mandam Origin em requisições
      // cross-site, então isso não abre a API pra qualquer site.
      if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error("Origem não permitida por CORS."));
    },
  })
);
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/products", productsRouter);
app.use("/tables", tablesRouter);
app.use("/orders", ordersRouter);
app.use("/payments", paymentsRouter);
app.use("/", adminRouter);

// Handler de erro genérico — nunca vaza stack trace/detalhe interno pro cliente.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

app.use((req, res) => res.status(404).json({ error: "Rota não encontrada." }));
