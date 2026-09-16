import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { authRouter } from "./routes/auth.js";
import { productsRouter } from "./routes/products.js";
import { tablesRouter } from "./routes/tables.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";

const PORT = process.env.PORT || 8787;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:8000";

const app = express();
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/products", productsRouter);
app.use("/tables", tablesRouter);
app.use("/orders", ordersRouter);
app.use("/", adminRouter);

// Handler de erro genérico — nunca vaza stack trace/detalhe interno pro cliente.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

app.use((req, res) => res.status(404).json({ error: "Rota não encontrada." }));

app.listen(PORT, () => {
  console.log(`Sunfood API rodando em http://localhost:${PORT} (CORS: ${CORS_ORIGIN})`);
});
