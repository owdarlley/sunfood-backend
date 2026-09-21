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

const validSignup = {
  name: "Ana",
  email: "ana@email.com",
  password: "123456",
  phone: "11987654321",
  birthDate: "2000-01-01",
  termsAccepted: true,
};

test("signupSchema exige senha com 6+ caracteres", () => {
  assert.equal(signupSchema.safeParse({ ...validSignup, password: "12345" }).success, false);
  assert.equal(signupSchema.safeParse(validSignup).success, true);
});

test("signupSchema exige telefone com 10+ dígitos", () => {
  assert.equal(signupSchema.safeParse({ ...validSignup, phone: "123" }).success, false);
  assert.equal(signupSchema.safeParse({ ...validSignup, phone: "(11) 98765-4321" }).success, true);
});

test("signupSchema exige 18 anos ou mais (cardápio vende bebida alcoólica)", () => {
  const menorDeIdade = new Date();
  menorDeIdade.setFullYear(menorDeIdade.getFullYear() - 17);
  const dataMenor = menorDeIdade.toISOString().slice(0, 10);
  assert.equal(signupSchema.safeParse({ ...validSignup, birthDate: dataMenor }).success, false);
  assert.equal(signupSchema.safeParse({ ...validSignup, birthDate: "2000-01-01" }).success, true);
});

test("signupSchema exige aceite dos termos", () => {
  assert.equal(signupSchema.safeParse({ ...validSignup, termsAccepted: false }).success, false);
  assert.equal(signupSchema.safeParse(validSignup).success, true);
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
