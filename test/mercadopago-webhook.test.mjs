import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { Payment, Preference } from "mercadopago";

Preference.prototype.create = async function() {
  return {
    id: "pref_mock_12345",
    init_point: "https://mercadopago.com/checkout/mock"
  };
};

const require = createRequire(import.meta.url);
const { default: app, verifyMercadoPagoSignature } = require("../dist/api.test.cjs");

const TEST_SECRET = "test_webhook_secret_key_123456789";

function createValidSignature(params) {
  const { dataId, requestId, secret = TEST_SECRET, timestamp = Math.floor(Date.now() / 1000) } = params;
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const hash = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return {
    xSignature: `ts=${timestamp},v1=${hash}`,
    xRequestId: requestId,
    timestamp,
    hash
  };
}

async function requestFromTemporaryServer(path, options) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fetch(`http://127.0.0.1:${address.port}${path}`, options);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// ========================================================
// 1. TESTES UNITÁRIOS DE CRIPTOGRAFIA E ASSINATURA HMAC
// ========================================================

test("Mercado Pago Signature: valida assinatura correta conforme especificação", () => {
  const dataId = "1234567890";
  const requestId = "req_abc_123";
  const { xSignature, xRequestId } = createValidSignature({ dataId, requestId });

  const result = verifyMercadoPagoSignature({
    xSignature,
    xRequestId,
    dataId,
    secret: TEST_SECRET
  });

  assert.equal(result.isValid, true);
  assert.equal(result.reason, undefined);
});

test("Mercado Pago Signature: rejeita assinatura com hash adulterado", () => {
  const dataId = "1234567890";
  const requestId = "req_abc_123";
  const { xSignature, xRequestId } = createValidSignature({ dataId, requestId });
  const tamperedSig = xSignature.replace(/v1=[0-9a-f]/, "v1=0");

  const result = verifyMercadoPagoSignature({
    xSignature: tamperedSig,
    xRequestId,
    dataId,
    secret: TEST_SECRET
  });

  assert.equal(result.isValid, false);
  assert.match(result.reason, /não confere|incompatível/i);
});

test("Mercado Pago Signature: rejeita se dataId foi alterado (adulteração de conteúdo)", () => {
  const dataId = "1234567890";
  const requestId = "req_abc_123";
  const { xSignature, xRequestId } = createValidSignature({ dataId, requestId });

  const result = verifyMercadoPagoSignature({
    xSignature,
    xRequestId,
    dataId: "9999999999", // dataId divergente do manifest assinado
    secret: TEST_SECRET
  });

  assert.equal(result.isValid, false);
});

test("Mercado Pago Signature: rejeita timestamp expirado (proteção contra replay attack)", () => {
  const dataId = "1234567890";
  const requestId = "req_abc_123";
  const oldTimestamp = Math.floor(Date.now() / 1000) - 900; // 15 minutos atrás
  const { xSignature, xRequestId } = createValidSignature({ dataId, requestId, timestamp: oldTimestamp });

  const result = verifyMercadoPagoSignature({
    xSignature,
    xRequestId,
    dataId,
    secret: TEST_SECRET
  });

  assert.equal(result.isValid, false);
  assert.match(result.reason, /expirado|tolerância|replay/i);
});

test("Mercado Pago Signature: rejeita quando o segredo está ausente (fail-closed)", () => {
  const dataId = "1234567890";
  const requestId = "req_abc_123";
  const { xSignature, xRequestId } = createValidSignature({ dataId, requestId });

  const result = verifyMercadoPagoSignature({
    xSignature,
    xRequestId,
    dataId,
    secret: "" // segredo ausente
  });

  assert.equal(result.isValid, false);
  assert.match(result.reason, /MERCADO_PAGO_WEBHOOK_SECRET ausente/i);
});

test("Mercado Pago Signature: rejeita headers ausentes ou incompletos", () => {
  const r1 = verifyMercadoPagoSignature({ secret: TEST_SECRET });
  assert.equal(r1.isValid, false);

  const r2 = verifyMercadoPagoSignature({ xSignature: "invalido", secret: TEST_SECRET });
  assert.equal(r2.isValid, false);
});

// ========================================================
// 2. TESTES DE ENDPOINT HTTP /api/mercadopago/webhook
// ========================================================

test("Webhook Endpoint: rejeita requisição com assinatura HMAC inválida quando secret configurado", async () => {
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  try {
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = TEST_SECRET;

    const response = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": "ts=1700000000,v1=deadbeefcafebabe",
        "x-request-id": "fake_req_id"
      },
      body: JSON.stringify({
        data: { id: "123456" }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error, "Assinatura do webhook inválida.");
  } finally {
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
  }
});

test("Webhook Endpoint: em produção (NODE_ENV=production), sem segredo configurado rejeita imediatamente (fail-closed)", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;

    const response = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: { id: "123456" }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error, "Assinatura do webhook inválida.");
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
  }
});

test("Webhook Endpoint: pagamento aprovado com pedido inexistente rejeita concessão de créditos", async () => {
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const originalGet = Payment.prototype.get;
  try {
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = TEST_SECRET;
    const testPaymentId = "pay_no_order_" + Date.now();
    const requestId = "req_" + Date.now();
    const sig = createValidSignature({ dataId: testPaymentId, requestId });

    // Mock do Mercado Pago retornando pagamento aprovado apontando para pedido inexistente
    Payment.prototype.get = async function() {
      return {
        id: testPaymentId,
        status: "approved",
        currency_id: "BRL",
        transaction_amount: 49.0,
        external_reference: "ord_non_existent_" + Date.now(),
        metadata: {
          userId: "user_fake",
          credits: 9999 // tentativa de forjar créditos
        }
      };
    };

    const response = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": sig.xSignature,
        "x-request-id": sig.xRequestId
      },
      body: JSON.stringify({
        data: { id: testPaymentId }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ignored, true);
    assert.equal(body.reason, "order_not_found");
  } finally {
    Payment.prototype.get = originalGet;
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
  }
});

test("Webhook Endpoint: pagamento com divergência de valor rejeita concessão de créditos", async () => {
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const originalGet = Payment.prototype.get;
  try {
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = TEST_SECRET;

    // Criar usuário e pedido legítimo de R$ 49.00
    const testUserEmail = `comprador_${Date.now()}@teste.com`;
    const mockUid = `uid_${Date.now()}`;
    const authHeader = `Bearer ${Buffer.from(JSON.stringify({ uid: mockUid, email: testUserEmail, email_verified: true })).toString("base64")}`;

    const regRes = await requestFromTemporaryServer("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify({
        birthName: "Comprador da Silva",
        birthDate: "1990-01-01",
        email: testUserEmail,
        termsAccepted: true,
        privacyAccepted: true
      })
    });
    const regData = await regRes.json();
    assert.equal(regRes.status, 200);
    const userId = regData.user.id;

    // Criar pedido no endpoint /api/credits/buy
    const buyRes = await requestFromTemporaryServer("/api/credits/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify({ planId: "prata" })
    });
    const buyData = await buyRes.json();
    assert.equal(buyRes.status, 200);
    const orderId = buyData.orderId;

    // Simular Mercado Pago com valor adulterado (ex: R$ 5.00 ao invés dos R$ 49.00 do pedido)
    const testPaymentId = "pay_divergent_val_" + Date.now();
    const requestId = "req_" + Date.now();
    const sig = createValidSignature({ dataId: testPaymentId, requestId });

    Payment.prototype.get = async function() {
      return {
        id: testPaymentId,
        status: "approved",
        currency_id: "BRL",
        transaction_amount: 5.0, // DIVERGENTE DO PEDIDO DE 49.00!
        external_reference: orderId,
        metadata: {
          userId,
          planId: "prata"
        }
      };
    };

    const webhookRes = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": sig.xSignature,
        "x-request-id": sig.xRequestId
      },
      body: JSON.stringify({
        data: { id: testPaymentId }
      })
    });

    const webhookBody = await webhookRes.json();
    assert.equal(webhookRes.status, 200);
    assert.equal(webhookBody.ignored, true);
    assert.equal(webhookBody.reason, "amount_mismatch");

    // Verificar que o usuário NÃO recebeu créditos indevidos
    const profileRes = await requestFromTemporaryServer("/api/user/profile", {
      headers: {
        "Authorization": authHeader
      }
    });
    const profileData = await profileRes.json();
    assert.equal(profileData.user.credits, regData.user.credits, "Créditos não podem ser alterados com valor divergente");
  } finally {
    Payment.prototype.get = originalGet;
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
  }
});

test("Webhook Endpoint: fluxo completo legítimo, idempotência e concorrência", async () => {
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const originalGet = Payment.prototype.get;
  try {
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = TEST_SECRET;

    // 1. Cadastrar usuário
    const testUserEmail = `legitimo_${Date.now()}@teste.com`;
    const mockUid = `uid_legit_${Date.now()}`;
    const authHeader = `Bearer ${Buffer.from(JSON.stringify({ uid: mockUid, email: testUserEmail, email_verified: true })).toString("base64")}`;

    const regRes = await requestFromTemporaryServer("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify({
        birthName: "Consulente Honrado",
        birthDate: "1988-06-20",
        email: testUserEmail,
        termsAccepted: true,
        privacyAccepted: true
      })
    });
    const regData = await regRes.json();
    assert.equal(regRes.status, 200);
    const userId = regData.user.id;
    const initialCredits = regData.user.credits;

    // 2. Criar pedido do Plano Prata (50 créditos, R$ 49,00)
    const buyRes = await requestFromTemporaryServer("/api/credits/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify({ planId: "prata" })
    });
    const buyData = await buyRes.json();
    const orderId = buyData.orderId;

    // 3. Simular confirmação oficial do pagamento
    const testPaymentId = "pay_legit_" + Date.now();
    const requestId = "req_" + Date.now();
    const sig = createValidSignature({ dataId: testPaymentId, requestId });

    Payment.prototype.get = async function() {
      return {
        id: testPaymentId,
        status: "approved",
        currency_id: "BRL",
        transaction_amount: 49.0,
        external_reference: orderId,
        metadata: {
          userId,
          orderId,
          planId: "prata"
        }
      };
    };

    // 4. Executar primeira chamada do Webhook
    const webhookRes1 = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": sig.xSignature,
        "x-request-id": sig.xRequestId
      },
      body: JSON.stringify({
        data: { id: testPaymentId }
      })
    });
    const webhookBody1 = await webhookRes1.json();
    assert.equal(webhookRes1.status, 200);
    assert.equal(webhookBody1.credited, true);

    // 5. Verificar que o saldo foi creditado exatamente com os 50 créditos do pedido
    const profRes1 = await requestFromTemporaryServer("/api/user/profile", {
      headers: { "Authorization": authHeader }
    });
    const profData1 = await profRes1.json();
    assert.equal(profData1.user.credits, initialCredits + 50);

    // 6. Teste de Idempotência: Segunda chamada do webhook com mesmo paymentId
    const webhookRes2 = await requestFromTemporaryServer("/api/mercadopago/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": sig.xSignature,
        "x-request-id": sig.xRequestId
      },
      body: JSON.stringify({
        data: { id: testPaymentId }
      })
    });
    const webhookBody2 = await webhookRes2.json();
    assert.equal(webhookRes2.status, 200);
    assert.equal(webhookBody2.alreadyProcessed, true);

    // 7. Saldo do usuário continua exatamente o mesmo (nenhum crédito duplicado)
    const profRes2 = await requestFromTemporaryServer("/api/user/profile", {
      headers: { "Authorization": authHeader }
    });
    const profData2 = await profRes2.json();
    assert.equal(profData2.user.credits, initialCredits + 50);

    // 8. Teste do Extrato / Ledger: verificar registro de type "purchase"
    const statementRes = await requestFromTemporaryServer("/api/credits/statement", {
      headers: { "Authorization": authHeader }
    });
    const statementData = await statementRes.json();
    assert.equal(statementRes.status, 200);
    const purchaseEntry = statementData.statement.find((item) => item.paymentId === testPaymentId);
    assert.ok(purchaseEntry, "Entrada de compra deve existir no extrato");
    assert.equal(purchaseEntry.type, "purchase", "Tipo do ledger deve ser padronizado como 'purchase'");
    assert.equal(purchaseEntry.amount, 50);
    assert.equal(purchaseEntry.source, "mercadopago");
  } finally {
    Payment.prototype.get = originalGet;
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
  }
});
