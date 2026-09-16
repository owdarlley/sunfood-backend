// node:sqlite é nativo do Node (>=22.5) — zero compilação nativa, funciona
// igual em Windows/Mac/Linux sem precisar de Visual Studio Build Tools/gcc
// (diferente de better-sqlite3, que exige toolchain de C++ pra instalar).
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "sunfood.db");

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// node:sqlite não tem um helper de transação embutido (como o
// db.transaction() do better-sqlite3) — este substitui esse padrão.
export function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cliente','admin','cozinha')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  long_description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('Bebidas','Lanches','Pratos','Sobremesas')),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  sold_out INTEGER NOT NULL DEFAULT 0,
  portion TEXT NOT NULL DEFAULT '',
  prep_time TEXT NOT NULL DEFAULT '',
  kcal TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
  ingredients TEXT NOT NULL DEFAULT '',
  image_key TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tables (
  number INTEGER PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  seats INTEGER NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_number INTEGER NOT NULL REFERENCES tables(number),
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('Na Fila','Em Preparo','Pronto','Entregue','Cancelado')) DEFAULT 'Na Fila',
  subtotal_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kiosk_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  day_closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS day_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_revenue_cents INTEGER NOT NULL,
  total_orders INTEGER NOT NULL,
  avg_ticket_cents INTEGER NOT NULL,
  top_products_json TEXT NOT NULL DEFAULT '[]'
);

INSERT OR IGNORE INTO kiosk_settings (id, paused, day_closed) VALUES (1, 0, 0);
`);

export default db;
