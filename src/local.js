// Ponto de entrada só pra rodar localmente (`npm start`). Em produção na
// Vercel, quem serve o app é api/index.js — funções serverless não chamam
// .listen(), a própria plataforma lida com o socket.
import { app } from "./app.js";

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Sunfood API rodando em http://localhost:${PORT}`);
});
