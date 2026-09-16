import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_ACCOUNTS = [
  { name: "Ana", email: "ana@email.com", password: "praia2026", role: "cliente" },
  { name: "Administrador", email: "admin@sunfood.com", password: "admin2026", role: "admin" },
  { name: "Equipe da cozinha", email: "cozinha@sunfood.com", password: "cozinha2026", role: "cozinha" },
];

function seedUsers() {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)"
  );
  for (const acc of DEMO_ACCOUNTS) {
    const hash = bcrypt.hashSync(acc.password, 12);
    insert.run(acc.name, acc.email, hash, acc.role);
  }
  console.log(`Seed: ${DEMO_ACCOUNTS.length} contas de demonstração garantidas.`);
}

function seedProducts() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  if (count > 0) {
    console.log(`Seed: produtos já existem (${count}), pulando.`);
    return;
  }
  const raw = readFileSync(path.join(__dirname, "products_seed.json"), "utf-8");
  const products = JSON.parse(raw);
  const insert = db.prepare(`
    INSERT INTO products
      (name, description, long_description, category, price_cents, sold_out,
       portion, prep_time, kcal, rating, review_count, ingredients, image_key, tags_json)
    VALUES (@name, @description, @long_description, @category, @price_cents, @sold_out,
            @portion, @prep_time, @kcal, @rating, @review_count, @ingredients, @image_key, @tags_json)
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      insert.run({
        name: p.name,
        description: p.desc,
        long_description: p.long,
        category: p.cat,
        price_cents: Math.round(p.price * 100),
        sold_out: p.soldOut ? 1 : 0,
        portion: p.porcao,
        prep_time: p.tempo,
        kcal: p.kcal,
        rating: p.nota,
        review_count: p.avaliacoes,
        ingredients: p.ingredientes,
        image_key: p.mark,
        tags_json: JSON.stringify(p.tags || []),
      });
    }
  });
  tx(products);
  console.log(`Seed: ${products.length} produtos inseridos.`);
}

function seedTables() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM tables").get().n;
  if (count > 0) {
    console.log(`Seed: mesas já existem (${count}), pulando.`);
    return;
  }
  const insert = db.prepare("INSERT INTO tables (number, active, seats) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (let n = 1; n <= 12; n++) {
      const active = n === 7 || n === 11 ? 0 : 1;
      const seats = n % 3 === 0 ? 6 : 4;
      insert.run(n, active, seats);
    }
  });
  tx();
  console.log("Seed: 12 mesas inseridas.");
}

seedUsers();
seedProducts();
seedTables();
console.log("Seed concluído.");
