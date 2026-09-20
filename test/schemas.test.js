import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loginSchema,
  signupSchema,
  createOrderSchema,
  orderStatusUpdateSchema,
  productSchema,
} from "../src/validation/schemas.js";

test("loginSchema exige e-mail válido e senha", () => {
  assert.equal(loginSchema.safeParse({ email: "não é email", password: "123456" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "ana@email.com", password: "1" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "ana@email.com", password: "praia2026" }).success, true);
});

test("signupSchema exige senha com 6+ caracteres", () => {
  assert.equal(signupSchema.safeParse({ name: "Ana", email: "ana@email.com", password: "12345" }).success, false);
  assert.equal(signupSchema.safeParse({ name: "Ana", email: "ana@email.com", password: "123456" }).success, true);
});

test("createOrderSchema exige productId em formato UUID (não mais número)", () => {
  const withNumericId = {
    tableNumber: 1,
    items: [{ productId: 42, qty: 1 }],
  };
  assert.equal(createOrderSchema.safeParse(withNumericId).success, false);

  const withUuid = {
    tableNumber: 1,
    items: [{ productId: "11111111-1111-1111-1111-111111111111", qty: 1 }],
  };
  assert.equal(createOrderSchema.safeParse(withUuid).success, true);
});

test("createOrderSchema rejeita carrinho vazio", () => {
  assert.equal(createOrderSchema.safeParse({ tableNumber: 1, items: [] }).success, false);
});

test("orderStatusUpdateSchema só aceita os 4 status de destino válidos", () => {
  for (const status of ["Em Preparo", "Pronto", "Entregue", "Cancelado"]) {
    assert.equal(orderStatusUpdateSchema.safeParse({ status }).success, true);
  }
  assert.equal(orderStatusUpdateSchema.safeParse({ status: "Na Fila" }).success, false);
  assert.equal(orderStatusUpdateSchema.safeParse({ status: "qualquer coisa" }).success, false);
});

test("productSchema rejeita categoria fora da lista e preço não positivo", () => {
  const base = { name: "Suco", category: "Bebidas", price: 10 };
  assert.equal(productSchema.safeParse(base).success, true);
  assert.equal(productSchema.safeParse({ ...base, category: "Outra" }).success, false);
  assert.equal(productSchema.safeParse({ ...base, price: 0 }).success, false);
  assert.equal(productSchema.safeParse({ ...base, price: -5 }).success, false);
});
