// Adaptador pra Vercel: toda rota (ver vercel.json) cai numa função
// serverless só, que é o próprio app Express — ele já sabe rotear
// internamente (/auth, /products, /orders, etc.).
export { app as default } from "../src/app.js";
