// Fluxo completo da API de verdade (Express + rotas + regras), do cadastro ao
// pedido entregue, com um Supabase falso em memória no lugar do banco: nada
// sai da máquina e nada é gravado em produção.
import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

const P1 = "00000000-0000-4000-8000-000000000001", P2 = "00000000-0000-4000-8000-000000000002", P3 = "00000000-0000-4000-8000-000000000003";

const db = {
  users: {}, // token -> { id, email }
  profiles: [],
  kiosk_settings: [{ id: 1, paused: false, day_closed: false, cancel_window_minutes: 0, min_order_cents: 1000 }],
  kiosk_tables: [1, 2, 3].map((number) => ({ number, active: number !== 2, seats: 4 })),
  products: [
    { id: P1, name: "Batata Frita", category: "Petiscos", price: 25, stock_qty: 3, sold_out: false },
    { id: P2, name: "Água de Coco", category: "Bebidas", price: 8, stock_qty: null, sold_out: false },
    { id: P3, name: "Açaí", category: "Sobremesas", price: 18, stock_qty: null, sold_out: true },
  ],
  orders: [],
  order_items: [],
  day_reports: [],
  pending: {}, // e-mails cadastrados que ainda não confirmaram
  passwords: {},
  resent: [],
};

const TRANSITIONS = { "Na Fila": ["Em Preparo", "Cancelado"], "Em Preparo": ["Pronto"], Pronto: ["Entregue"] };

// Query builder mínimo, com só o que as rotas usam.
function query(table) {
  const filters = [];
  let op = "select", patch = null, rows = null, embed = false, mode = "many";
  const q = {
    select(cols = "*") { if (op === "select") op = "select"; embed = cols.includes("order_items"); return q; },
    insert(r) { op = "insert"; rows = [].concat(r); return q; },
    update(p) { op = "update"; patch = p; return q; },
    eq(c, v) { filters.push((r) => r[c] === v); return q; },
    in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
    lt(c, v) { filters.push((r) => r[c] < v); return q; },
    order() { return q; },
    limit() { return q; },
    single() { mode = "single"; return q; },
    maybeSingle() { mode = "maybe"; return q; },
    then(ok, fail) { return Promise.resolve(run()).then(ok, fail); },
  };
  function run() {
    const all = db[table];
    let out;
    if (op === "insert") { out = rows.map((r) => ({ id: "n" + Math.random().toString(36).slice(2), ...r })); all.push(...out); }
    else {
      out = all.filter((r) => filters.every((f) => f(r)));
      if (op === "update") out.forEach((r) => Object.assign(r, patch));
    }
    out = out.map((r) => (embed ? { ...r, order_items: db.order_items.filter((i) => i.order_id === r.id) } : { ...r }));
    if (mode === "many") return { data: out, error: null };
    if (!out.length) return { data: null, error: mode === "single" ? { message: "no rows" } : null };
    return { data: out[0], error: null };
  }
  return q;
}

function setStatus(id, status) {
  const o = db.orders.find((x) => x.id === id);
  if (!(TRANSITIONS[o.status] || []).includes(status)) return { error: { message: "invalid_transition" } };
  if (status === "Cancelado") {
    for (const it of db.order_items.filter((i) => i.order_id === id)) {
      const p = db.products.find((x) => x.id === it.product_id);
      if (p.stock_qty !== null) p.stock_qty += it.qty;
    }
  }
  o.status = status;
  return { data: null, error: null };
}

const rpc = async (name, args) => {
  if (name === "create_order") {
    const p = args.payload;
    for (const it of p.items) {
      const prod = db.products.find((x) => x.id === it.productId);
      if (prod.stock_qty !== null && prod.stock_qty < it.qty) return { error: { message: "out_of_stock:" + prod.name } };
    }
    const id = "o" + (db.orders.length + 1);
    db.orders.push({ id, customer_id: p.customerId, table_number: p.tableNumber, status: "Na Fila", subtotal: p.subtotal,
      total: p.total, note: p.note, payment_method: p.paymentMethod || "pix", payment_status: "pending",
      created_at: new Date().toISOString() });
    for (const it of p.items) {
      db.order_items.push({ order_id: id, product_id: it.productId, name: it.name, price: it.price, qty: it.qty });
      const prod = db.products.find((x) => x.id === it.productId);
      if (prod.stock_qty !== null) prod.stock_qty -= it.qty;
    }
    return { data: { id }, error: null };
  }
  if (name === "set_order_status") return setStatus(args.p_order_id, args.p_status);
  if (name === "close_day") {
    if (db.kiosk_settings[0].day_closed) return { error: { message: "day_already_closed" } };
    db.kiosk_settings[0].day_closed = true;
    return { data: { id: "r1", totalOrders: db.orders.length }, error: null };
  }
  return { data: {}, error: null };
};

const auth = {
  async getUser(token) {
    const u = db.users[token];
    return u ? { data: { user: u }, error: null } : { data: null, error: { message: "bad token" } };
  },
  async signUp({ email, password, options }) {
    if (db.passwords[email]) return { data: {}, error: { message: "User already registered" } };
    const id = "u" + (db.profiles.length + 1);
    db.passwords[email] = password;
    db.pending[email] = true;
    // Igual ao trigger handle_new_user do banco.
    db.profiles.push({ id, email, name: options.data.name, role: "cliente", phone: options.data.phone,
      cpf: options.data.cpf ?? null, birth_date: options.data.birth_date, terms_accepted_at: options.data.terms_accepted_at });
    return { data: { user: { id }, session: null }, error: null };
  },
  async signInWithPassword({ email, password }) {
    if (db.passwords[email] !== password) return { data: {}, error: { message: "Invalid login" } };
    if (db.pending[email]) return { data: {}, error: { code: "email_not_confirmed", message: "Email not confirmed" } };
    const prof = db.profiles.find((p) => p.email === email);
    const token = "tok-" + prof.id;
    db.users[token] = { id: prof.id, email };
    return { data: { user: { id: prof.id, email }, session: { access_token: token, refresh_token: "r" } }, error: null };
  },
  async resend({ email }) { db.resent.push(email); return { error: null }; },
  async resetPasswordForEmail() { return { error: null }; },
  admin: {
    async deleteUser(id) {
      db.profiles = db.profiles.filter((p) => p.id !== id);
      db.orders.filter((o) => o.customer_id === id).forEach((o) => (o.customer_id = null)); // ON DELETE SET NULL
      for (const [t, u] of Object.entries(db.users)) if (u.id === id) delete db.users[t];
      return { error: null };
    },
  },
};

const fake = { from: (t) => query(t), rpc, auth };
mock.module("../src/supabase.js", { namedExports: { supabaseAdmin: fake, supabaseAuth: fake } });

let base, server;
before(async () => {
  delete process.env.MERCADOPAGO_ACCESS_TOKEN; // pagamentos no modo provisório
  const { app } = await import("../src/app.js");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function staff(role) {
  const id = role + "-1";
  db.profiles.push({ id, email: role + "@sunfood.com", name: role, role });
  db.users["tok-" + id] = { id, email: role + "@sunfood.com" };
  return "tok-" + id;
}

const ana = { name: "Ana Teste", email: "ana@teste.com", password: "senha-forte-123", phone: "11999999999",
  cpf: "529.982.247-25", birthDate: "2000-01-01", termsAccepted: true };
let anaToken;

test("cadastro cria conta e pede confirmação por e-mail", async () => {
  const r = await api("POST", "/auth/signup", ana);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.requiresEmailConfirmation, true);
  assert.equal(db.profiles.find((p) => p.email === ana.email).cpf, "52998224725", "grava só os dígitos");
  const again = await api("POST", "/auth/signup", { ...ana, cpf: "111.444.777-35" });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /já tem cadastro/);
});

test("cadastro recusa CPF inválido ou de outra conta", async () => {
  const outra = { ...ana, email: "outra@teste.com" };
  for (const cpf of ["123.456.789-00", "111.111.111-11", "5299822472", ""]) {
    const r = await api("POST", "/auth/signup", { ...outra, cpf });
    assert.equal(r.status, 400, cpf);
    assert.equal(r.body.details[0].path[0], "cpf", cpf);
  }
  const r = await api("POST", "/auth/signup", outra);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /CPF já está cadastrado/);
  assert.ok(!db.passwords[outra.email], "não cria a conta");
});

test("login com e-mail não confirmado avisa e permite reenviar", async () => {
  const r = await api("POST", "/auth/login", { email: ana.email, password: ana.password });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "email_not_confirmed");
  const wrong = await api("POST", "/auth/login", { email: ana.email, password: "errada-123" });
  assert.equal(wrong.status, 401, "senha errada não pode revelar que falta confirmar");
  const re = await api("POST", "/auth/resend-confirmation", { email: ana.email });
  assert.equal(re.status, 200);
  assert.deepEqual(db.resent, [ana.email]);
});

test("depois de confirmar, login entra como cliente", async () => {
  delete db.pending[ana.email];
  const r = await api("POST", "/auth/login", { email: ana.email, password: ana.password });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "cliente");
  assert.equal(r.body.user.profileComplete, true);
  anaToken = r.body.token;
  const me = await api("GET", "/auth/me", null, anaToken);
  assert.equal(me.body.user.email, ana.email);
});

test("cardápio mostra estoque e esgotado", async () => {
  const r = await api("GET", "/products");
  const byName = Object.fromEntries(r.body.map((p) => [p.name, p]));
  assert.equal(byName["Batata Frita"].stockQty, 3);
  assert.equal(byName["Açaí"].soldOut, true);
});

test("regras do pedido: mínimo, esgotado, estoque, mesa inativa", async () => {
  const pedir = (items, tableNumber = 1) => api("POST", "/orders", { tableNumber, items, paymentMethod: "entrega" }, anaToken);
  let r = await pedir([{ productId: P2, qty: 1 }]);
  assert.equal(r.status, 422, "R$ 8 é abaixo do mínimo de R$ 10");
  assert.match(r.body.error, /Pedido mínimo de R\$ 10,00/);
  r = await pedir([{ productId: P3, qty: 1 }]);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /indisponível/);
  r = await pedir([{ productId: P1, qty: 4 }]);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /restam 3/);
  r = await pedir([{ productId: P1, qty: 1 }], 2);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /inativa/);
});

test("admin muda o pedido mínimo e o cliente sente na hora", async () => {
  const admin = staff("admin");
  let r = await api("PATCH", "/kiosk-settings/min-order", { minOrder: 5 }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.minOrder, 5);
  r = await api("POST", "/orders", { tableNumber: 1, items: [{ productId: P2, qty: 1 }], paymentMethod: "entrega" }, anaToken);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await api("PATCH", "/kiosk-settings/min-order", { minOrder: 10 }, admin);
  r = await api("PATCH", "/kiosk-settings/min-order", { minOrder: 10 }, anaToken);
  assert.equal(r.status, 403, "cliente não pode mudar o mínimo");
});

let pixOrder;
test("PIX provisório: aprovado na hora e vai para a cozinha", async () => {
  let r = await api("POST", "/orders", { tableNumber: 1, items: [{ productId: P1, qty: 2 }], paymentMethod: "pix" }, anaToken);
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 55);
  pixOrder = r.body.id;
  const cozinha = staff("cozinha");
  let fila = await api("GET", "/orders", null, cozinha);
  assert.ok(!fila.body.some((o) => o.id === pixOrder), "PIX não pago não aparece na cozinha");
  r = await api("POST", `/payments/pix/${pixOrder}`, {}, anaToken);
  assert.equal(r.body.provisional, true);
  fila = await api("GET", "/orders", null, cozinha);
  assert.ok(fila.body.some((o) => o.id === pixOrder && o.paymentProvider === "provisorio"));
  assert.equal(db.products[0].stock_qty, 1, "estoque baixou 2");
});

test("cozinha leva o pedido até Entregue e não pula etapas", async () => {
  const cozinha = "tok-cozinha-1";
  let r = await api("PATCH", `/orders/${pixOrder}/status`, { status: "Pronto" }, cozinha);
  assert.equal(r.status, 422);
  for (const s of ["Em Preparo", "Pronto", "Entregue"]) {
    r = await api("PATCH", `/orders/${pixOrder}/status`, { status: s }, cozinha);
    assert.equal(r.status, 200, s);
  }
  r = await api("POST", `/orders/${pixOrder}/cancel`, {}, anaToken);
  assert.equal(r.status, 409, "pedido entregue não pode ser cancelado");
});

test("cliente cancela pedido na fila, estoque volta, e prazo é respeitado", async () => {
  let r = await api("POST", "/orders", { tableNumber: 3, items: [{ productId: P1, qty: 1 }], paymentMethod: "entrega" }, anaToken);
  const id = r.body.id;
  assert.equal(db.products[0].stock_qty, 0);
  const outra = staff("cliente");
  r = await api("POST", `/orders/${id}/cancel`, {}, outra);
  assert.equal(r.status, 403, "outro cliente não cancela pedido alheio");
  r = await api("POST", `/orders/${id}/cancel`, {}, anaToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "Cancelado");
  assert.equal(db.products[0].stock_qty, 1);

  r = await api("POST", "/orders", { tableNumber: 3, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, anaToken);
  const late = r.body.id;
  db.orders.find((o) => o.id === late).created_at = new Date(Date.now() - 10 * 60000).toISOString();
  await api("PATCH", "/kiosk-settings/cancel-window", { minutes: 5 }, "tok-admin-1");
  r = await api("POST", `/orders/${late}/cancel`, {}, anaToken);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /prazo/);
  await api("PATCH", "/kiosk-settings/cancel-window", { minutes: 0 }, "tok-admin-1");
});

test("admin anota pagamento recebido na entrega", async () => {
  const entrega = db.orders.find((o) => o.payment_method === "entrega" && o.status === "Na Fila");
  let r = await api("PATCH", `/orders/${entrega.id}/payment-received`, { receivedWith: "dinheiro" }, "tok-admin-1");
  assert.equal(r.status, 200);
  assert.equal(r.body.paymentStatus, "approved");
  r = await api("PATCH", `/orders/${pixOrder}/payment-received`, { receivedWith: "dinheiro" }, "tok-admin-1");
  assert.equal(r.status, 409, "PIX não é pagamento na entrega");
});

test("quiosque pausado e dia encerrado recusam pedidos", async () => {
  const admin = "tok-admin-1";
  const pedir = () => api("POST", "/orders", { tableNumber: 1, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, anaToken);
  await api("PATCH", "/kiosk-settings/pause", { paused: true }, admin);
  let r = await pedir();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /pausado/);
  await api("PATCH", "/kiosk-settings/pause", { paused: false }, admin);
  r = await api("POST", "/close-day", null, admin);
  assert.equal(r.status, 201);
  r = await api("POST", "/close-day", null, admin);
  assert.equal(r.status, 409);
  r = await pedir();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /encerrou o dia/);
  r = await api("GET", "/kiosk-settings");
  assert.equal(r.body.dayClosed, true);
  await api("POST", "/reopen-day", null, admin);
  r = await pedir();
  assert.equal(r.status, 201);
});

test("login com Google: completa telefone, CPF, nascimento e termos antes de pedir", async () => {
  // O Supabase cria a conta direto no retorno do Google; o trigger só tem nome e e-mail.
  db.profiles.push({ id: "g1", email: "bia@gmail.com", name: "Bia Google", role: "cliente",
    phone: null, birth_date: null, terms_accepted_at: null });
  db.users["tok-g1"] = { id: "g1", email: "bia@gmail.com" };
  let r = await api("GET", "/auth/me", null, "tok-g1");
  assert.equal(r.body.user.profileComplete, false);
  r = await api("POST", "/orders", { tableNumber: 1, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, "tok-g1");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "profile_incomplete");
  const dados = { name: "Bia Google", phone: "11988887777", cpf: "111.444.777-35", birthDate: "2015-01-01", termsAccepted: true };
  r = await api("POST", "/auth/complete-profile", dados, "tok-g1");
  assert.equal(r.status, 400, "menor de idade não completa");
  r = await api("POST", "/auth/complete-profile", { ...dados, birthDate: "1999-05-05", cpf: "111.444.777-36" }, "tok-g1");
  assert.equal(r.status, 400, "CPF com dígito errado não completa");
  r = await api("POST", "/auth/complete-profile", { ...dados, birthDate: "1999-05-05", cpf: ana.cpf }, "tok-g1");
  assert.equal(r.status, 409, "CPF de outra conta não completa");
  r = await api("POST", "/auth/complete-profile", { ...dados, birthDate: "1999-05-05", termsAccepted: false }, "tok-g1");
  assert.equal(r.status, 400, "sem aceitar os termos não completa");
  r = await api("POST", "/auth/complete-profile", { ...dados, birthDate: "1999-05-05" }, "tok-g1");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.profileComplete, true);
  assert.ok(db.profiles.find((p) => p.id === "g1").terms_accepted_at);
  assert.equal(db.profiles.find((p) => p.id === "g1").cpf, "11144477735");
  r = await api("GET", "/auth/me", null, "tok-g1");
  assert.equal(r.body.user.profileComplete, true);
  r = await api("POST", "/orders", { tableNumber: 1, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, "tok-g1");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await api("GET", "/auth/me", null, "tok-admin-1");
  assert.equal(r.body.user.profileComplete, true, "equipe não precisa completar");
});

test("conta antiga sem CPF precisa completar antes de pedir", async () => {
  db.profiles.push({ id: "v1", email: "velho@teste.com", name: "Cliente Antigo", role: "cliente",
    phone: "11977776666", cpf: null, birth_date: "1990-01-01", terms_accepted_at: "2026-09-01T00:00:00Z" });
  db.users["tok-v1"] = { id: "v1", email: "velho@teste.com" };
  let r = await api("GET", "/auth/me", null, "tok-v1");
  assert.equal(r.body.user.profileComplete, false);
  r = await api("POST", "/orders", { tableNumber: 1, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, "tok-v1");
  assert.equal(r.status, 403);
  assert.match(r.body.error, /CPF/);
});

test("excluir conta apaga o acesso e mantém os pedidos sem dono", async () => {
  const antes = db.orders.filter((o) => o.customer_id === db.users[anaToken].id).length;
  assert.ok(antes > 0);
  const r = await api("POST", "/auth/delete-account", null, anaToken);
  assert.equal(r.status, 200);
  const me = await api("GET", "/auth/me", null, anaToken);
  assert.equal(me.status, 401);
  assert.ok(db.orders.length >= antes, "pedidos continuam no histórico");
  assert.ok(db.orders.every((o) => o.customer_id !== "u1"));
});
