import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key-de-teste";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-de-teste";
const { requireRole } = await import("../src/middleware/auth.js");

function fakeReqRes(user) {
  const req = { user };
  const result = { statusCode: null, body: null, nextCalled: false };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    },
  };
  const next = () => {
    result.nextCalled = true;
  };
  return { req, res, next, result };
}

test("requireRole deixa passar quando o papel do usuário está na lista", () => {
  const { req, res, next, result } = fakeReqRes({ role: "admin" });
  requireRole("admin", "cozinha")(req, res, next);
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

test("requireRole bloqueia com 403 quando o papel não está na lista", () => {
  const { req, res, next, result } = fakeReqRes({ role: "cliente" });
  requireRole("admin", "cozinha")(req, res, next);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test("requireRole bloqueia quando não há usuário autenticado", () => {
  const { req, res, next, result } = fakeReqRes(undefined);
  requireRole("admin")(req, res, next);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test("um cliente nunca cai na lista de admin/cozinha (RBAC não deixa vazar)", () => {
  const attempt1 = fakeReqRes({ role: "cliente" });
  requireRole("admin")(attempt1.req, attempt1.res, attempt1.next);
  assert.equal(attempt1.result.statusCode, 403);

  const attempt2 = fakeReqRes({ role: "cliente" });
  requireRole("cozinha")(attempt2.req, attempt2.res, attempt2.next);
  assert.equal(attempt2.result.statusCode, 403);
});
