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
  contact_messages: [],
  pending: {}, // e-mails cadastrados que ainda não confirmaram
  passwords: {},
  resent: [],
  resetSent: [],
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
    is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
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
  if (name === "set_table_count") {
    // Igual à função do banco: cria as que faltam, apaga as que sobram sem pedido.
    const n = args.p_count;
    db.kiosk_settings[0].table_count = n;
    for (let i = 1; i <= n; i++) if (!db.kiosk_tables.some((t) => t.number === i)) db.kiosk_tables.push({ number: i, active: true, seats: 4 });
    db.kiosk_tables = db.kiosk_tables.filter((t) => t.number <= n || db.orders.some((o) => o.table_number === t.number));
    return { data: n, error: null };
  }
  if (name === "delete_or_archive_product") {
    // Igual à função do banco: apaga se nenhum pedido usa, senão arquiva.
    const p = db.products.find((x) => x.id === args.p_id && !x.archived_at);
    if (!p) return { error: { message: "product_not_found" } };
    if (db.order_items.some((i) => i.product_id === p.id)) {
      Object.assign(p, { archived_at: new Date().toISOString(), sold_out: false });
      return { data: { action: "archived", imageUrl: p.image_url ?? null }, error: null };
    }
    db.products = db.products.filter((x) => x !== p);
    return { data: { action: "deleted", imageUrl: p.image_url ?? null }, error: null };
  }
  if (name === "set_order_status") return setStatus(args.p_order_id, args.p_status);
  if (name === "close_day") {
    if (db.kiosk_settings[0].day_closed) return { error: { message: "day_already_closed" } };
    db.kiosk_settings[0].day_closed = true;
    return { data: { id: "r1", totalOrders: db.orders.length }, error: null };
  }
  if (name === "sales_report") {
    db.lastReportDays = args.p_days;
    // O Postgres devolve numeric como texto no JSON; a rota converte.
    return { data: { from: "2026-10-05", to: "2026-10-05", revenue: "80.00", orders: 2, avgTicket: "40.00", itemsSold: "7",
      topProducts: [{ name: "Água de Coco", qty: "6", revenue: "60.00" }],
      byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hour === 12 ? 2 : 0, revenue: hour === 12 ? "80.00" : 0 })),
      byDay: [{ date: "2026-10-05", orders: 2, revenue: "80.00" }] }, error: null };
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
  async resetPasswordForEmail(email) { db.resetSent.push(email); return { error: null }; },
  admin: {
    async getUserById(id) {
      const p = db.profiles.find((x) => x.id === id);
      return { data: { user: p && { id, email: p.email, app_metadata: { providers: p.providers || ["email"] } } }, error: null };
    },
    async deleteUser(id) {
      db.profiles = db.profiles.filter((p) => p.id !== id);
      db.orders.filter((o) => o.customer_id === id).forEach((o) => (o.customer_id = null)); // ON DELETE SET NULL
      for (const [t, u] of Object.entries(db.users)) if (u.id === id) delete db.users[t];
      return { error: null };
    },
  },
};

// Storage falso: guarda os arquivos enviados (e apagados) em memória.
const uploads = [];
const removed = [];
const storage = {
  from: (bucket) => ({
    async upload(path, body, opts) { uploads.push({ bucket, path, body, opts }); return { data: { path }, error: null }; },
    async remove(paths) { removed.push(...paths.map((path) => ({ bucket, path }))); return { data: [], error: null }; },
  }),
};

const fake = { from: (t) => query(t), rpc, auth, storage };
mock.module("../src/supabase.js", { namedExports: { supabaseAdmin: fake, supabaseAuth: fake } });
// E-mail falso: guarda o que a API mandaria pela Resend.
const sentEmails = [];
let emailOn = true, emailFails = false;
mock.module("../src/email.js", {
  namedExports: {
    emailConfigured: () => emailOn,
    sendEmail: async (m) => {
      if (emailFails) throw new Error("resend fora do ar");
      sentEmails.push(m);
      return { id: "e" + sentEmails.length };
    },
  },
});

let base, server;
before(async () => {
  process.env.SUPABASE_URL = "https://teste.supabase.co";
  delete process.env.MERCADOPAGO_ACCESS_TOKEN; // pagamentos no modo provisório
  const { app } = await import("../src/app.js");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body, token, ip) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}) },
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

test("esqueci minha senha: avisa e-mail sem conta e conta só do Google", async () => {
  const ok = await api("POST", "/auth/forgot-password", { email: " ANA@teste.com " });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(db.resetSent, ["ana@teste.com"], "manda o link para a conta certa");
  const nope = await api("POST", "/auth/forgot-password", { email: "ana@tste.com" });
  assert.equal(nope.status, 404);
  assert.equal(nope.body.code, "email_not_found");
  assert.match(nope.body.error, /Não encontramos uma conta/);
  db.profiles.push({ id: "g-1", email: "bia@gmail.com", name: "Bia", role: "cliente", providers: ["google"] });
  const google = await api("POST", "/auth/forgot-password", { email: "bia@gmail.com" });
  assert.equal(google.status, 400);
  assert.equal(google.body.code, "google_account");
  assert.equal(db.resetSent.length, 1, "não manda e-mail nos casos de erro");
});

test("esqueci minha senha pelo CPF: manda pro e-mail da conta e mostra ele mascarado", async () => {
  const sent = db.resetSent.length;
  // IP próprio: o limite de 5 pedidos por IP já foi gasto no teste anterior.
  const forgot = (body) => api("POST", "/auth/forgot-password", body, null, "10.0.0.9");
  const ok = await forgot({ cpf: "529.982.247-25" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.resetSent.at(-1), "ana@teste.com", "link vai pro e-mail cadastrado");
  assert.equal(ok.body.sentTo, "a*a@teste.com");
  assert.ok(!JSON.stringify(ok.body).includes("ana@teste.com"), "não expõe o e-mail inteiro");
  const nope = await forgot({ cpf: "111.444.777-35" });
  assert.equal(nope.status, 404);
  assert.equal(nope.body.code, "cpf_not_found");
  const bad = await forgot({ cpf: "123.456.789-00" });
  assert.equal(bad.status, 400);
  const empty = await forgot({});
  assert.equal(empty.status, 400);
  db.profiles.push({ id: "g-2", email: "caio@gmail.com", cpf: "39053344705", name: "Caio", role: "cliente", providers: ["google"] });
  const google = await forgot({ cpf: "390.533.447-05" });
  assert.equal(google.status, 400);
  assert.equal(google.body.code, "google_account");
  assert.equal(google.body.sentTo, "c**o@gmail.com");
  db.profiles.pop();
  assert.equal(db.resetSent.length, sent + 1, "só manda e-mail no caso certo");
});

test("esqueci minha senha: limite de pedidos por IP vale pro CPF também", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await api("POST", "/auth/forgot-password", { cpf: "111.444.777-35" }, null, "10.0.0.10");
  assert.equal(last.status, 429);
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
test("admin muda a localização do quiosque e o cliente vê", async () => {
  const admin = "tok-admin-1";
  let r = await api("GET", "/kiosk-settings");
  assert.equal(r.body.location.name, "Quiosque Sunfood · Praia do Forte", "sem coluna no banco: texto padrão");
  const novo = { name: "Sunfood na Faculdade", address: "Av. Brasil, 100 - Centro, Santos - SP", hours: "Seg. a sex., 8h às 22h." };
  r = await api("PATCH", "/kiosk-settings/location", novo, anaToken);
  assert.equal(r.status, 403, "cliente não muda a localização");
  r = await api("PATCH", "/kiosk-settings/location", { ...novo, address: "  " }, admin);
  assert.equal(r.status, 400);
  r = await api("PATCH", "/kiosk-settings/location", { ...novo, name: "x".repeat(81) }, admin);
  assert.equal(r.status, 400);
  r = await api("PATCH", "/kiosk-settings/location", { ...novo, name: "  Sunfood na Faculdade  " }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.location, novo);
  r = await api("GET", "/kiosk-settings");
  assert.deepEqual(r.body.location, novo);
});

test("admin escolhe quantas mesas existem e o pedido respeita", async () => {
  const admin = "tok-admin-1";
  const pedir = (tableNumber) => api("POST", "/orders", { tableNumber, items: [{ productId: P2, qty: 2 }], paymentMethod: "entrega" }, anaToken);
  let r = await api("PATCH", "/kiosk-settings/table-count", { count: 5 }, anaToken);
  assert.equal(r.status, 403, "cliente não muda a quantidade de mesas");
  r = await api("PATCH", "/kiosk-settings/table-count", { count: 0 }, admin);
  assert.equal(r.status, 400);
  r = await api("PATCH", "/kiosk-settings/table-count", { count: 2.5 }, admin);
  assert.equal(r.status, 400);
  r = await api("PATCH", "/kiosk-settings/table-count", { count: 5 }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.tableCount, 5);
  r = await api("GET", "/tables");
  assert.deepEqual(r.body.map((t) => t.number), [1, 2, 3, 4, 5]);
  r = await pedir(6);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Mesa 6 não existe\. O quiosque tem mesas de 1 a 5/);
  r = await pedir(5);
  assert.equal(r.status, 201, "mesa nova já aceita pedido");
  r = await api("PATCH", "/kiosk-settings/table-count", { count: 3 }, admin);
  assert.equal(r.status, 200);
  r = await api("GET", "/tables");
  assert.deepEqual(r.body.map((t) => t.number), [1, 2, 3], "mesa 5 tem pedido: fica guardada mas some da lista");
  r = await pedir(5);
  assert.equal(r.status, 404);
  r = await api("GET", "/kiosk-settings");
  assert.equal(r.body.tableCount, 3);
});

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

test("relatórios do admin: período, números e só admin vê", async () => {
  const admin = staff("admin");
  const cozinha = staff("cozinha");
  assert.equal((await api("GET", "/reports/sales")).status, 401);
  assert.equal((await api("GET", "/reports/sales", null, cozinha)).status, 403);
  assert.equal((await api("GET", "/reports/sales?period=1ano", null, admin)).status, 400);

  const hoje = await api("GET", "/reports/sales", null, admin);
  assert.equal(hoje.status, 200);
  assert.equal(db.lastReportDays, 1, "sem período = hoje");
  assert.equal(hoje.body.revenue, 80);
  assert.equal(hoje.body.topProducts[0].qty, 6);
  assert.equal(hoje.body.byHour.length, 24);
  assert.equal(hoje.body.byHour[12].revenue, 80);

  await api("GET", "/reports/sales?period=7d", null, admin);
  assert.equal(db.lastReportDays, 7);
  const r30 = await api("GET", "/reports/sales?period=30d", null, admin);
  assert.equal(db.lastReportDays, 30);
  assert.equal(r30.body.period, "30d");
});

test("fale conosco grava a mensagem e só o admin lê e marca como respondida", async () => {
  const ok = { name: "Bruna Lima", contact: "(13) 98888-7777", reason: "Reservar mesa ou guarda-sol", message: "Quero reservar uma mesa para 6 no sábado." };
  const r = await api("POST", "/contact", ok);
  assert.equal(r.status, 201);
  assert.match(r.body.protocol, /^SF-\d{6}$/);
  assert.equal(db.contact_messages.length, 1);

  assert.equal((await api("POST", "/contact", { ...ok, contact: "abc" })).status, 400);
  assert.equal((await api("POST", "/contact", { ...ok, message: "curta" })).status, 400);
  assert.equal((await api("POST", "/contact", { ...ok, reason: "Outro" })).status, 400);

  const admin = staff("admin");
  assert.equal((await api("GET", "/contact")).status, 401);
  assert.equal((await api("GET", "/contact", null, staff("cozinha"))).status, 403);
  const lista = await api("GET", "/contact", null, admin);
  assert.equal(lista.status, 200);
  assert.equal(lista.body[0].protocol, r.body.protocol);
  assert.equal(lista.body[0].name, "Bruna Lima");

  const id = lista.body[0].id;
  const upd = await api("PATCH", "/contact/" + id + "/status", { status: "respondido" }, admin);
  assert.equal(upd.status, 200);
  assert.equal(upd.body.status, "respondido");
  assert.equal((await api("PATCH", "/contact/" + id + "/status", { status: "lido" }, admin)).status, 400);
});

test("admin responde o fale conosco: e-mail sai pela Resend, telefone fica como WhatsApp", async () => {
  const admin = staff("admin");
  const base = { reason: "Tirar dúvida sobre o cardápio", message: "Vocês têm opção sem glúten <b>hoje</b>?" };
  await api("POST", "/contact", { ...base, name: "Carla Souza", contact: "carla@email.com" }, null, "10.0.0.51");
  await api("POST", "/contact", { ...base, name: "Davi Reis", contact: "(13) 97777-6666" }, null, "10.0.0.52");
  const porEmail = db.contact_messages.find((m) => m.contact === "carla@email.com");
  const porFone = db.contact_messages.find((m) => m.name === "Davi Reis");
  const url = (m) => "/contact/" + m.id + "/reply";

  assert.equal((await api("POST", url(porEmail), { reply: "Temos sim!" })).status, 401);
  assert.equal((await api("POST", url(porEmail), { reply: "Temos sim!" }, staff("cozinha"))).status, 403);
  assert.equal((await api("POST", url(porEmail), { reply: " " }, admin)).status, 400);
  assert.equal((await api("POST", "/contact/nao-existe/reply", { reply: "Temos sim!" }, admin)).status, 404);

  // Sem chave da Resend ou com a Resend fora: não grava nada como respondido.
  emailOn = false;
  const semChave = await api("POST", url(porEmail), { reply: "Temos sim!" }, admin);
  assert.equal(semChave.status, 503);
  assert.equal(semChave.body.code, "email_not_configured");
  emailOn = true; emailFails = true;
  assert.equal((await api("POST", url(porEmail), { reply: "Temos sim!" }, admin)).status, 502);
  emailFails = false;
  assert.notEqual(porEmail.status, "respondido");
  assert.equal(porEmail.reply, undefined);
  assert.equal(sentEmails.length, 0);

  const ok = await api("POST", url(porEmail), { reply: "Temos sim!\nO pão sem glúten sai na hora." }, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "respondido");
  assert.equal(ok.body.replyChannel, "email");
  assert.equal(ok.body.reply, "Temos sim!\nO pão sem glúten sai na hora.");
  assert.ok(ok.body.repliedAt);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "carla@email.com");
  assert.match(sentEmails[0].subject, /SF-\d{6}/);
  assert.match(sentEmails[0].html, /Olá, Carla!/);
  assert.match(sentEmails[0].html, /Temos sim!<br>O pão/);
  assert.match(sentEmails[0].html, /&lt;b&gt;hoje&lt;\/b&gt;/, "texto do cliente vai escapado no HTML");

  const fone = await api("POST", url(porFone), { reply: "Temos sim!" }, admin);
  assert.equal(fone.status, 200);
  assert.equal(fone.body.replyChannel, "whatsapp");
  assert.equal(fone.body.status, "respondido");
  assert.equal(sentEmails.length, 1, "telefone não gera e-mail");

  const lista = await api("GET", "/contact", null, admin);
  assert.equal(lista.body.find((m) => m.id === porEmail.id).reply, "Temos sim!\nO pão sem glúten sai na hora.");
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

test("admin envia foto do produto e ela aparece no cardápio", async () => {
  const admin = staff("admin");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 1)]);
  const enviar = (body, token, type = "image/jpeg") =>
    fetch(base + "/products/images", { method: "POST", body,
      headers: { "Content-Type": type, ...(token ? { Authorization: "Bearer " + token } : {}) } });

  assert.equal((await enviar(jpg)).status, 401);
  assert.equal((await enviar(jpg, staff("cozinha"))).status, 403);
  const html = await enviar(Buffer.from("<html><script>alert(1)</script>"), admin, "image/jpeg");
  assert.equal(html.status, 400, "confere a assinatura, não o Content-Type");
  assert.equal((await enviar(Buffer.alloc(3 * 1024 * 1024, 0xff), admin)).status, 413);

  const r = await enviar(jpg, admin);
  assert.equal(r.status, 201);
  const { url } = await r.json();
  assert.match(url, /^https:\/\/teste\.supabase\.co\/storage\/v1\/object\/public\/produtos\/[0-9a-f-]+\.jpg$/);
  assert.equal(uploads.at(-1).bucket, "produtos");
  assert.equal(uploads.at(-1).opts.contentType, "image/jpeg");
  assert.ok(uploads.at(-1).body.equals(jpg));

  const produto = { name: "Batata Frita", category: "Lanches", price: 25 };
  const fora = await api("PUT", "/products/" + P1, { ...produto, imageUrl: "https://site-qualquer.com/x.jpg" }, admin);
  assert.equal(fora.status, 400, "só aceita foto do nosso bucket");
  const ok = await api("PUT", "/products/" + P1, { ...produto, imageUrl: url }, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.imageUrl, url);
  const semMexer = await api("PUT", "/products/" + P1, produto, admin);
  assert.equal(semMexer.body.imageUrl, url, "editar sem mandar imageUrl mantém a foto");
  const menu = await api("GET", "/products");
  assert.equal(menu.body.find((p) => p.id === P1).imageUrl, url);
  const tirar = await api("PUT", "/products/" + P1, { ...produto, imageUrl: null }, admin);
  assert.equal(tirar.body.imageUrl, null);
});

test("admin exclui item: sem pedido apaga (e a foto), com pedido arquiva", async () => {
  const admin = staff("admin");
  const novo = await api("POST", "/products", { name: "Pastel", category: "Lanches", price: 12,
    imageUrl: "https://teste.supabase.co/storage/v1/object/public/produtos/pastel.jpg" }, admin);
  assert.equal(novo.status, 201);

  assert.equal((await api("DELETE", "/products/" + novo.body.id)).status, 401);
  assert.equal((await api("DELETE", "/products/" + novo.body.id, null, staff("cozinha"))).status, 403);

  const apagado = await api("DELETE", "/products/" + novo.body.id, null, admin);
  assert.equal(apagado.status, 200);
  assert.equal(apagado.body.action, "deleted");
  assert.ok(!db.products.some((p) => p.id === novo.body.id), "saiu do banco");
  assert.deepEqual(removed.at(-1), { bucket: "produtos", path: "pastel.jpg" }, "foto apagada do Storage");
  assert.equal((await api("DELETE", "/products/" + novo.body.id, null, admin)).status, 404);

  // P2 (Água de Coco) já foi pedido nos testes anteriores.
  assert.ok(db.order_items.some((i) => i.product_id === P2));
  const fotosAntes = removed.length;
  const arquivado = await api("DELETE", "/products/" + P2, null, admin);
  assert.equal(arquivado.body.action, "archived");
  assert.equal(removed.length, fotosAntes, "foto de produto arquivado fica");
  assert.ok(db.order_items.some((i) => i.product_id === P2), "histórico continua");
  const menu = await api("GET", "/products");
  assert.ok(!menu.body.some((p) => p.id === P2), "some do cardápio");
  assert.equal((await api("PUT", "/products/" + P2, { name: "Água", category: "Bebidas", price: 8 }, admin)).status, 404);
  assert.equal((await api("PATCH", "/products/" + P2 + "/sold-out", { soldOut: true }, admin)).status, 404);
  assert.equal((await api("DELETE", "/products/" + P2, null, admin)).status, 404);

  // A conta da Ana foi excluída num teste anterior: outra cliente, já completa.
  db.profiles.push({ id: "cli-2", email: "bia@teste.com", name: "Bia", role: "cliente", phone: "11988887777",
    cpf: "11144477735", birth_date: "2000-01-01", terms_accepted_at: new Date().toISOString() });
  db.users["tok-cli-2"] = { id: "cli-2", email: "bia@teste.com" };
  const pedido = await api("POST", "/orders", { tableNumber: 1, paymentMethod: "pix",
    items: [{ productId: P2, qty: 2 }] }, "tok-cli-2");
  assert.equal(pedido.status, 409, "carrinho antigo com item excluído não passa");
  assert.match(pedido.body.error, /saiu do cardápio/);
});
