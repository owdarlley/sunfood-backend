import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loginSchema,
  signupSchema,
  createOrderSchema,
  paymentReceivedSchema,
  kioskCancelWindowSchema,
  orderStatusUpdateSchema,
  productSchema,
  resendConfirmationSchema,
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
  cpf: "529.982.247-25",
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

test("signupSchema exige CPF com dígitos verificadores certos e grava só os números", () => {
  for (const cpf of ["123.456.789-00", "529.982.247-24", "000.000.000-00", "999.999.999-99", "5299822472", "abc", ""]) {
    assert.equal(signupSchema.safeParse({ ...validSignup, cpf }).success, false, cpf);
  }
  const { cpf, ...semCpf } = validSignup;
  assert.equal(signupSchema.safeParse(semCpf).success, false);
  assert.equal(signupSchema.parse(validSignup).cpf, "52998224725");
  assert.equal(signupSchema.parse({ ...validSignup, cpf: "11144477735" }).cpf, "11144477735");
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

test("productSchema: estoque ausente não vira null (não sobrescreve o saldo na edição)", () => {
  const base = { name: "Suco", category: "Bebidas", price: 10 };
  assert.equal(productSchema.parse(base).stockQty, undefined);
  assert.equal(productSchema.parse({ ...base, stockQty: null }).stockQty, null);
  assert.equal(productSchema.parse({ ...base, stockQty: 5 }).stockQty, 5);
  assert.equal(productSchema.safeParse({ ...base, stockQty: -1 }).success, false);
  assert.equal(productSchema.safeParse({ ...base, stockQty: 1.5 }).success, false);
});

test("forma de pagamento do pedido: padrão PIX, só aceita pix/cartao/entrega", () => {
  const base = { tableNumber: 3, items: [{ productId: "3f1c6a52-6b1e-4b8e-9d0a-0c6c4a1b2d3e", qty: 1 }] };
  assert.equal(createOrderSchema.parse(base).paymentMethod, "pix");
  assert.equal(createOrderSchema.parse({ ...base, paymentMethod: "entrega" }).paymentMethod, "entrega");
  assert.equal(createOrderSchema.safeParse({ ...base, paymentMethod: "fiado" }).success, false);
});

test("prazo de cancelamento aceita minutos inteiros de 0 a 120", () => {
  assert.equal(kioskCancelWindowSchema.safeParse({ minutes: 0 }).success, true);
  assert.equal(kioskCancelWindowSchema.safeParse({ minutes: 10 }).success, true);
  assert.equal(kioskCancelWindowSchema.safeParse({ minutes: 121 }).success, false);
  assert.equal(kioskCancelWindowSchema.safeParse({ minutes: -1 }).success, false);
  assert.equal(kioskCancelWindowSchema.safeParse({ minutes: 2.5 }).success, false);
});

test("recebimento aceita dinheiro, cartao, pix ou null (desfazer)", () => {
  for (const v of ["dinheiro", "cartao", "pix", null]) assert.equal(paymentReceivedSchema.safeParse({ receivedWith: v }).success, true);
  assert.equal(paymentReceivedSchema.safeParse({ receivedWith: "cheque" }).success, false);
  assert.equal(paymentReceivedSchema.safeParse({}).success, false);
});

test("resendConfirmationSchema exige um e-mail válido", () => {
  assert.equal(resendConfirmationSchema.safeParse({ email: " ana@email.com " }).success, true);
  assert.equal(resendConfirmationSchema.safeParse({ email: "ana" }).success, false);
  assert.equal(resendConfirmationSchema.safeParse({}).success, false);
});
