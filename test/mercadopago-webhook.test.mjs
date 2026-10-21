import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test, { beforeEach } from "node:test";

// Valores exclusivamente simulados, definidos antes de carregar a API.
// Strings vazias impedem dotenv de importar credenciais reais neste processo.
Object.assign(process.env, {
  NODE_ENV: "test", VERCEL: "", VERCEL_ENV: "",
  FIREBASE_PROJECT_ID: "", FIREBASE_CLIENT_EMAIL: "", FIREBASE_PRIVATE_KEY: "",
  FIRESTORE_EMULATOR_HOST: "", ENFORCE_APP_CHECK: "false",
  GEMINI_API_KEY: "MY_GEMINI_API_KEY", API_KEY: "MY_GEMINI_API_KEY",
  MERCADO_PAGO_ACCESS_TOKEN: "TEST-local-only-not-a-real-token",
  MERCADO_PAGO_WEBHOOK_SECRET: "local-test-secret-not-for-production",
  APP_URL: "https://exu-test.example.invalid",
  SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", ADMIN_SALES_EMAIL: "",
});
const SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
const ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const require = createRequire(import.meta.url);
// Mesmo módulo CommonJS utilizado pelo bundle da API.
const { Payment, Preference } = require("mercadopago");
const { default: app, getAppFirestore } = require("../dist/api.test.cjs");
const firestore = getAppFirestore();
const payments = new Map();
let paymentCalls;
let preferenceBodies;
let nextId = 900000000;
const paymentId = () => String(++nextId);

beforeEach((t) => {
  process.env.NODE_ENV = "test";
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = SECRET;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = ACCESS_TOKEN;
  payments.clear();
  paymentCalls = [];
  preferenceBodies = [];
  t.mock.method(Payment.prototype, "get", async ({ id }) => {
    paymentCalls.push(String(id));
    assert.ok(payments.has(String(id)), "Pagamento não preparado no mock; acesso externo proibido");
    return structuredClone(payments.get(String(id)));
  });
  t.mock.method(Preference.prototype, "create", async ({ body }) => {
    preferenceBodies.push(structuredClone(body));
    return { id: `pref_${crypto.randomUUID()}`, init_point: "https://checkout.example.invalid/mock" };
  });
  // Bloqueia fetch externo caso alguma integração tente sair dos mocks.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url || input);
    assert.equal(url.hostname, "127.0.0.1", "Rede externa proibida neste teste");
    return realFetch(input, options);
  });
});

async function request(path, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function signature(id, requestId, timestamp = Date.now()) {
  const hash = crypto.createHmac("sha256", SECRET)
    .update(`id:${id};request-id:${requestId};ts:${timestamp};`).digest("hex");
  return `ts=${timestamp},v1=${hash}`;
}

async function notify(id, options = {}) {
  const requestId = crypto.randomUUID();
  const signed = signature(options.signedId ?? id, requestId, options.timestamp);
  return request(options.withoutQuery ? "/api/mercadopago/webhook" :
    `/api/mercadopago/webhook?data.id=${encodeURIComponent(id)}&type=payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-request-id": requestId,
      "x-signature": options.badSignature ? signed.replace(/v1=./, match => match === "v1=0" ? "v1=1" : "v1=0") : signed,
      ...options.headers,
    },
    body: JSON.stringify({ type: "payment", data: { id: options.bodyId ?? id } }),
  });
}

async function createUser() {
  const id = `usr_${crypto.randomUUID()}`;
  const uid = `uid_${crypto.randomUUID()}`;
  const email = `${uid}@example.invalid`;
  const user = { id, firebaseUid: uid, email, emailVerified: true,
    name: "Comprador Teste", credits: 5, xp: 0, level: "Buscador", role: "user", isBlocked: false };
  await firestore.collection("users").doc(id).set(user);
  return { ...user, authorization: `Bearer ${Buffer.from(JSON.stringify({ uid, email, email_verified: true })).toString("base64")}` };
}

async function checkout(user, extra = {}) {
  return request("/api/credits/buy", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: user.authorization },
    body: JSON.stringify({ planId: "prata", ...extra }),
  });
}

async function fixture() {
  const user = await createUser();
  const response = await checkout(user);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const orderId = response.body.orderId;
  const order = (await firestore.collection("orders").doc(orderId).get()).data();
  assert.equal(order.price, 49);
  assert.equal(order.credits, 50);
  assert.equal(order.userId, user.id);
  const id = paymentId();
  payments.set(id, {
    id, status: "approved", live_mode: true, currency_id: "BRL",
    transaction_amount: order.price, external_reference: orderId,
    metadata: { user_id: user.id, order_id: orderId, plan_id: order.planId },
  });
  return { user, orderId, order, id };
}

async function state(f) {
  return {
    user: (await firestore.collection("users").doc(f.user.id).get()).data(),
    order: (await firestore.collection("orders").doc(f.orderId).get()).data(),
    payment: (await firestore.collection("payments").doc(f.id).get()).data(),
    ledger: (await firestore.collection("credit_ledger").where("userId", "==", f.user.id).get()).docs.map(doc => doc.data()),
  };
}

async function assertNotCredited(f) {
  const saved = await state(f);
  if (saved.user) { assert.equal(saved.user.credits, 5); assert.equal(saved.user.xp, 0); }
  assert.equal(saved.order.status, "pending");
  assert.notEqual(saved.payment?.status, "credited");
  assert.equal(saved.ledger.length, 0);
}

async function assertCreditedOnce(f) {
  const saved = await state(f);
  assert.equal(saved.user.credits, 55);
  assert.equal(saved.user.xp, 245);
  assert.equal(saved.order.status, "completed");
  assert.equal(saved.order.paymentId, f.id);
  assert.equal(saved.payment.status, "credited");
  assert.equal(saved.payment.orderId, f.orderId);
  assert.equal(saved.ledger.length, 1);
  assert.equal(saved.ledger[0].type, "purchase");
  assert.equal(saved.ledger[0].source, "mercadopago");
  assert.equal(saved.ledger[0].amount, 50);
  assert.equal(saved.ledger[0].paymentId, f.id);
}

test("Checkout: preço e créditos vêm do servidor, mesmo com payload adulterado", async () => {
  const user = await createUser();
  const res = await checkout(user, { price: 0.01, credits: 99999, userId: "outro_usuario" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const order = (await firestore.collection("orders").doc(res.body.orderId).get()).data();
  assert.equal(order.price, 49); assert.equal(order.credits, 50); assert.equal(order.userId, user.id);
  assert.equal(preferenceBodies.length, 1);
  assert.equal(preferenceBodies[0].items[0].unit_price, 49);
  assert.equal(preferenceBodies[0].external_reference, res.body.orderId);
});

test("Assinatura: hash adulterado é rejeitado antes de consultar o provedor", async () => {
  const res = await notify(paymentId(), { badSignature: true });
  assert.equal(res.status, 401); assert.equal(res.body.received, false);
  assert.equal(paymentCalls.length, 0);
});

test("Assinatura: alteração do data.id assinado é rejeitada", async () => {
  const res = await notify(paymentId(), { signedId: paymentId() });
  assert.equal(res.status, 401); assert.equal(paymentCalls.length, 0);
});

test("Assinatura: URL sem data.id, corpo divergente e cabeçalho ausente são rejeitados", async () => {
  for (const options of [{ withoutQuery: true }, { bodyId: "123" }, { headers: { "x-signature": "" } }]) {
    assert.equal((await notify(paymentId(), options)).status, 401);
  }
  assert.equal(paymentCalls.length, 0);
});

test("Configuração: segredo ou token ausente impede confirmação de pagamento", async () => {
  for (const key of ["MERCADO_PAGO_WEBHOOK_SECRET", "MERCADO_PAGO_ACCESS_TOKEN"]) {
    const previous = process.env[key];
    try {
      process.env[key] = "";
      const res = await notify(paymentId());
      assert.equal(res.status, 503); assert.equal(res.body.credited, false);
    } finally { process.env[key] = previous; }
  }
  assert.equal(paymentCalls.length, 0);
});

test("Pedido inexistente não gera registro de compra ou créditos", async () => {
  const id = paymentId();
  payments.set(id, { id, status: "approved", currency_id: "BRL", transaction_amount: 49,
    external_reference: `ord_${crypto.randomUUID()}`, metadata: { credits: 99999 } });
  const res = await notify(id);
  assert.equal(res.status, 503); assert.equal(res.body.credited, false);
  assert.equal((await firestore.collection("credit_ledger").doc(`mp_pay_${id}`).get()).exists, false);
  assert.equal((await firestore.collection("payments").doc(id).get()).exists, false);
});

test("Valor divergente por um centavo impede concessão de créditos", async () => {
  const f = await fixture(); payments.get(f.id).transaction_amount = 48.99;
  const res = await notify(f.id);
  assert.equal(res.status, 503); assert.equal(res.body.credited, false);
  await assertNotCredited(f);
});

test("Moeda divergente impede concessão de créditos", async () => {
  const f = await fixture(); payments.get(f.id).currency_id = "USD";
  assert.equal((await notify(f.id)).status, 503); await assertNotCredited(f);
});

test("Usuário divergente nos metadados impede concessão de créditos", async () => {
  const f = await fixture(); payments.get(f.id).metadata.user_id = "outro_usuario";
  assert.equal((await notify(f.id)).status, 503); await assertNotCredited(f);
});

test("Usuário removido antes da confirmação não produz entrega fictícia", async () => {
  const f = await fixture(); await firestore.collection("users").doc(f.user.id).delete();
  const res = await notify(f.id);
  assert.equal(res.status, 503); assert.equal(res.body.credited, false);
  await assertNotCredited(f);
});

test("Pagamento aprovado: duas notificações simultâneas e uma repetição creditam uma única vez", async () => {
  const f = await fixture();
  const responses = await Promise.all([notify(f.id), notify(f.id)]);
  for (const res of responses) { assert.equal(res.status, 200, JSON.stringify(res.body)); assert.equal(res.body.credited, true); }
  assert.deepEqual(responses.map(res => res.body.alreadyProcessed).sort(), [false, true]);
  const repeated = await notify(f.id);
  assert.equal(repeated.status, 200); assert.equal(repeated.body.alreadyProcessed, true);
  await assertCreditedOnce(f);
});

test("Reenvio assinado antigo não duplica entrega; aceita ts em segundos e milissegundos", async () => {
  const f = await fixture();
  const first = await notify(f.id, { timestamp: Math.floor(Date.now() / 1000) });
  assert.equal(first.status, 200);
  const repeated = await notify(f.id, { timestamp: Date.now() - 86400000 });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.alreadyProcessed, true);
  await assertCreditedOnce(f);
});

test("Evento pendente atrasado preserva o comprovante de crédito", async () => {
  const f = await fixture(); assert.equal((await notify(f.id)).status, 200);
  payments.get(f.id).status = "pending";
  const pending = await notify(f.id);
  assert.equal(pending.status, 200); assert.equal(pending.body.credited, false);
  await assertCreditedOnce(f);
  payments.get(f.id).status = "approved";
  const replay = await notify(f.id);
  assert.equal(replay.status, 200); assert.equal(replay.body.alreadyProcessed, true);
  await assertCreditedOnce(f);
});

test("Segundo pagamento para pedido concluído não entrega créditos novamente", async () => {
  const f = await fixture(); assert.equal((await notify(f.id)).status, 200);
  const second = paymentId(); payments.set(second, { ...payments.get(f.id), id: second });
  const res = await notify(second);
  assert.equal(res.status, 503); assert.equal(res.body.credited, false);
  await assertCreditedOnce(f);
});

test("Reversão após entrega preserva comprovante e sinaliza conferência", async () => {
  const f = await fixture(); assert.equal((await notify(f.id)).status, 200);
  payments.get(f.id).status = "charged_back";
  assert.equal((await notify(f.id)).status, 200);
  await assertCreditedOnce(f);
  const saved = await state(f);
  assert.equal(saved.payment.reviewRequired, true);
  assert.equal(saved.payment.providerStatus, "charged_back");
});

test("Falha transacional retorna 503 sem alterar saldo; reenvio recupera a entrega", async (t) => {
  const f = await fixture();
  const original = firestore.runTransaction.bind(firestore);
  // Falha antes do commit; o rate limiter também pode tentar usar a transação.
  const stub = t.mock.method(firestore, "runTransaction", async () => { throw new Error("Banco indisponível (teste)"); });
  const res = await notify(f.id);
  assert.equal(res.status, 503); assert.equal(res.body.credited, false);
  await assertNotCredited(f);
  stub.mock.restore();
  assert.equal(typeof original, "function");
  const retry = await notify(f.id);
  assert.equal(retry.status, 200); assert.equal(retry.body.alreadyProcessed, false);
  await assertCreditedOnce(f);
});

test("Resposta do provedor com outro paymentId é rejeitada", async () => {
  const f = await fixture(); payments.get(f.id).id = paymentId();
  assert.equal((await notify(f.id)).status, 503); await assertNotCredited(f);
});
