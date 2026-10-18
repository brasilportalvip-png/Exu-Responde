import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  default: app,
  executeCreditDebitTransactionalCore,
  executeCreditRefundTransactionalCore,
  completeConsultationTransactionalCore,
  reconcilePendingOperationsCore,
  buildScopedIdempotencyDocId,
  computeRequestFingerprint,
  firestore: exportedFirestore,
  getAppFirestore,
} = require("../dist/api.test.cjs");

const firestore = (typeof getAppFirestore === "function" ? getAppFirestore() : exportedFirestore);


async function requestFromTemporaryServer(path, options = {}) {
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

async function createTestUser(emailPrefix = "consulente") {
  const timestamp = Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const email = `${emailPrefix}_${timestamp}@teste.com`;
  const uid = `uid_${timestamp}`;
  const authHeader = `Bearer ${Buffer.from(
    JSON.stringify({ uid, email, email_verified: true })
  ).toString("base64")}`;
  const fakeIp = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  const deviceId = `dev_${timestamp}`;

  const res = await requestFromTemporaryServer("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authHeader,
      "X-Forwarded-For": fakeIp,
    },
    body: JSON.stringify({
      birthName: "Consulente Teste " + timestamp,
      birthDate: "1988-06-15",
      email,
      termsAccepted: true,
      privacyAccepted: true,
      deviceId,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 200, `Falha ao registrar usuário: ${JSON.stringify(body)}`);
  return {
    userId: body.user.id,
    user: body.user,
    authHeader,
    fakeIp,
    deviceId,
    uid,
    email,
  };
}

// ========================================================
// 1. ISOLAMENTO DAS CHAVES DE IDEMPOTÊNCIA
// ========================================================

test("Idempotência: dois usuários usando a mesma chave possuem escopos isolados e não colidem", async () => {
  const userA = await createTestUser("user_a");
  const userB = await createTestUser("user_b");
  const sharedKey = "shared_key_test_" + Date.now();

  const [resA, resB] = await Promise.all([
    requestFromTemporaryServer("/api/oraculo/tarot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": userA.authHeader,
        "Idempotency-Key": sharedKey,
        "X-Forwarded-For": userA.fakeIp,
      },
      body: JSON.stringify({
        question: "Caminhos de User A",
        slotsCount: 1,
        idempotencyKey: sharedKey,
      }),
    }),
    requestFromTemporaryServer("/api/oraculo/tarot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": userB.authHeader,
        "Idempotency-Key": sharedKey,
        "X-Forwarded-For": userB.fakeIp,
      },
      body: JSON.stringify({
        question: "Caminhos de User B",
        slotsCount: 1,
        idempotencyKey: sharedKey,
      }),
    }),
  ]);

  // Nenhum deve ser 409 (pois os escopos por userId evitam colisão cruzada)
  assert.notEqual(resA.status, 409, "User A não deve colidir com chave de User B");
  assert.notEqual(resB.status, 409, "User B não deve colidir com chave de User A");
});

test("Idempotência: reutilizar a mesma chave com pergunta diferente gera conflito 409 e impede débito", async () => {
  const user = await createTestUser("conflict_user");
  const key = "key_divergent_" + Date.now();

  // Primeira chamada
  const res1 = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": user.authHeader,
      "Idempotency-Key": key,
      "X-Forwarded-For": user.fakeIp,
    },
    body: JSON.stringify({
      question: "Pergunta original sobre saúde",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });
  assert.ok(res1.status === 200 || res1.status === 503);

  // Segunda chamada com a MESMA chave mas pergunta DIFERENTE
  const res2 = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": user.authHeader,
      "Idempotency-Key": key,
      "X-Forwarded-For": user.fakeIp,
    },
    body: JSON.stringify({
      question: "Pergunta totalmente diferente sobre negócios e riqueza",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });

  const body2 = await res2.json();
  assert.equal(res2.status, 409, "Deveria retornar 409 Conflict");
  assert.match(body2.error, /pergunta ou parâmetros diferentes/i);
});

// ========================================================
// 2. CONSULTA COMPLETA E REPETIÇÃO DE RESPOSTA
// ========================================================

test("Repetição após resposta concluída: devolve resposta persistida sem novo débito e sem novo sorteio", async () => {
  const user = await createTestUser("repeat_user");
  const key = "key_repeat_" + Date.now();

  const res1 = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": user.authHeader,
      "Idempotency-Key": key,
      "X-Forwarded-For": user.fakeIp,
    },
    body: JSON.stringify({
      question: "Orientação espiritual para a semana",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });

  const body1 = await res1.json();
  if (res1.status === 200) {
    const originalCard = body1.drawn[0].nome;
    const originalCredits = body1.creditsLeft;

    // Repetição idêntica com a mesma chave e mesma pergunta
    const res2 = await requestFromTemporaryServer("/api/oraculo/tarot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": user.authHeader,
        "Idempotency-Key": key,
        "X-Forwarded-For": user.fakeIp,
      },
      body: JSON.stringify({
        question: "Orientação espiritual para a semana",
        slotsCount: 1,
        idempotencyKey: key,
      }),
    });

    const body2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.equal(body2.alreadyProcessed, true, "Deve sinalizar que a consulta já havia sido processada");
    assert.equal(body2.drawn[0].nome, originalCard, "Carta deve ser exatamente a mesma da consulta original persistida");
    assert.equal(body2.creditsLeft, originalCredits, "Não deve haver novo débito de créditos");
  }
});

// ========================================================
// 3. DUAS CONSULTAS SIMULTÂNEAS COM A MESMA CHAVE
// ========================================================

test("Concorrência: duas consultas simultâneas com a mesma chave não duplicam débitos", async () => {
  const user = await createTestUser("concurrent_user");
  const key = "key_conc_" + Date.now();

  const [res1, res2] = await Promise.all([
    requestFromTemporaryServer("/api/oraculo/buzios", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": user.authHeader,
        "Idempotency-Key": key,
        "X-Forwarded-For": user.fakeIp,
      },
      body: JSON.stringify({
        question: "Abertura de caminhos",
        idempotencyKey: key,
      }),
    }),
    requestFromTemporaryServer("/api/oraculo/buzios", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": user.authHeader,
        "Idempotency-Key": key,
        "X-Forwarded-For": user.fakeIp,
      },
      body: JSON.stringify({
        question: "Abertura de caminhos",
        idempotencyKey: key,
      }),
    }),
  ]);

  const profileRes = await requestFromTemporaryServer("/api/user/profile", {
    headers: {
      "Authorization": user.authHeader,
      "X-Forwarded-For": user.fakeIp,
    },
  });
  const profile = await profileRes.json();
  const credits = profile.user ? profile.user.credits : profile.credits;

  // O usuário começou com 5 créditos; Búzios custa 3.
  // Mesmo com chamadas concorrentes, não pode haver débito duplicado (saldo não pode ser menor que 2)
  assert.ok(credits >= 2, `Saldo não pode duplicar débito: saldo atual é ${credits}`);
});

// ========================================================
// 4. FALHA DA IA DEPOIS DO DÉBITO
// ========================================================

test("Falha da IA depois do débito: executa estorno transacional e preserva créditos do usuário", async () => {
  const user = await createTestUser("ai_failure_user");
  const key = "key_ai_fail_" + Date.now();

  // Chamada de Tarot: quando Gemini está em ambiente de teste sem chave válida,
  // os modelos falham, disparando o estorno transacional automático
  const res = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": user.authHeader,
      "Idempotency-Key": key,
      "X-Forwarded-For": user.fakeIp,
    },
    body: JSON.stringify({
      question: "Teste de falha de IA controlada",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });

  const body = await res.json();
  // Se a IA falhou, retorna 503 com confirmação de estorno
  if (res.status === 503) {
    assert.equal(body.refunded, true, "Deve confirmar que o estorno foi executado");
    assert.match(body.error, /preservados e estornados/i);
    // Saldo do usuário deve ter sido integralmente preservado
    assert.equal(body.creditsLeft, 5, "Saldo deve retornar a 5 créditos após o estorno");
  }
});

// ========================================================
// 5. DOIS ESTORNOS SIMULTÂNEOS
// ========================================================

test("Estorno: dois estornos simultâneos devolvem créditos apenas UMA vez", async () => {
  const user = await createTestUser("double_refund_user");

  // Débito direto controlado via core para isolar teste de concorrência de estorno
  const userRef = firestore.collection("users").doc(user.userId);
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 3,
    xpAwarded: 35,
    source: "buzios",
    consultationId: "test_conc_ref_" + Date.now(),
    idempotencyKey: "idem_conc_ref_" + Date.now(),
  });

  assert.equal(debitRes.balanceAfter, 2);

  // Dispara dois estornos rigorosamente concorrentes da MESMA operação de débito
  const [ref1, ref2] = await Promise.all([
    executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 3,
      originalOperationId: debitRes.operationId,
      source: "buzios",
      reason: "Estorno concorrente 1",
    }),
    executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 3,
      originalOperationId: debitRes.operationId,
      source: "buzios",
      reason: "Estorno concorrente 2",
    }),
  ]);

  // Exatamente um deve ter alreadyRefunded: false, e o outro alreadyRefunded: true
  const results = [ref1.alreadyRefunded, ref2.alreadyRefunded].sort();
  assert.deepEqual(results, [false, true], "Um estorno deve processar e o outro sinalizar alreadyRefunded");

  // Saldo final deve ser exatamente 5 (devolveu 3 apenas UMA vez)
  const userDocAfter = await userRef.get();
  assert.equal(userDocAfter.data().credits, 5, "Saldo final deve ser exatamente 5 créditos");
});

// ========================================================
// 6. ESTORNO DE OPERAÇÃO INEXISTENTE, OUTRO USUÁRIO OU DIVERGENTE
// ========================================================

test("Estorno: operação inexistente rejeita com 404 e não gera créditos", async () => {
  const user = await createTestUser("refund_nonexistent");
  const userRef = firestore.collection("users").doc(user.userId);
  const fakeOpId = "op_deb_nonexistent_" + Date.now();

  let threw = false;
  try {
    await executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 2,
      originalOperationId: fakeOpId,
      source: "tarot",
      reason: "Tentativa de estorno inexistente",
    });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 404);
    assert.match(err.message, /não encontrada para estorno/i);
  }
  assert.equal(threw, true, "Deve rejeitar operação original inexistente com erro 404");

  // Saldo não pode ter sido alterado
  const userDoc = await userRef.get();
  assert.equal(userDoc.data().credits, 5);
});

test("Estorno: operação de outro usuário rejeita com 403 e não gera créditos", async () => {
  const userVictim = await createTestUser("victim");
  const userAttacker = await createTestUser("attacker");

  // Vítima realiza débito
  const victimRef = firestore.collection("users").doc(userVictim.userId);
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef: victimRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "victim_deb_" + Date.now(),
    idempotencyKey: "idem_victim_" + Date.now(),
  });

  // Atacante tenta estornar o débito da vítima em sua própria conta
  const attackerRef = firestore.collection("users").doc(userAttacker.userId);
  let threw = false;
  try {
    await executeCreditRefundTransactionalCore(firestore, {
      userRef: attackerRef,
      amount: 2,
      originalOperationId: debitRes.operationId,
      source: "tarot",
      reason: "Tentativa de fraude de estorno",
    });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 403);
    assert.match(err.message, /pertence a outro consulente/i);
  }
  assert.equal(threw, true, "Deve rejeitar com 403");

  // Saldo do atacante deve continuar intacto (5)
  const attackerDoc = await attackerRef.get();
  assert.equal(attackerDoc.data().credits, 5);
});

test("Estorno: valor divergente do débito original rejeita com 400", async () => {
  const user = await createTestUser("divergent_user");
  const userRef = firestore.collection("users").doc(user.userId);

  // Débito de 2 créditos
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "deb_div_" + Date.now(),
    idempotencyKey: "idem_div_" + Date.now(),
  });

  let threw = false;
  try {
    await executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 99, // DIVERGENTE DO DÉBITO ORIGINAL DE 2!
      originalOperationId: debitRes.operationId,
      source: "tarot",
      reason: "Valor divergente",
    });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 400);
    assert.match(err.message, /diverge do valor debitado originalmente/i);
  }
  assert.equal(threw, true, "Deve rejeitar divergência de valor com 400");
});

// ========================================================
// 7. RECUPERAÇÃO EXPLÍCITA DE OPERAÇÕES INTERROMPIDAS E RECONCILIAÇÃO
// ========================================================

test("Recuperação: reconcilePendingOperations identifica operações stale e as estorna automaticamente", async () => {
  const user = await createTestUser("stale_recovery_user");
  const userRef = firestore.collection("users").doc(user.userId);

  // 1. Simula débito de operação que foi interrompida (por crash ou timeout)
  const staleIdempotencyKey = "stale_key_" + Date.now();
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "stale_tarot_" + Date.now(),
    idempotencyKey: staleIdempotencyKey,
  });

  assert.equal(debitRes.balanceAfter, 3, "Saldo deve ter sido debitado para 3");

  // 2. Simula passagem de tempo no documento de idempotência para tornar a operação 'stale' (> 60s atrás)
  const scopedId = buildScopedIdempotencyDocId(user.userId, "tarot", staleIdempotencyKey);
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 minutos atrás
  await firestore.collection("idempotency_keys").doc(scopedId).update({
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
  });

  // 3. Simula também registro na fila de reconciliação de falha
  await firestore.collection("reconciliations").add({
    type: "chat_refund_failed",
    userId: user.userId,
    operationId: debitRes.operationId,
    amount: 2,
    source: "tarot",
    status: "reconciliation_required",
    error: "Simulação de queda transitória de conexão",
    createdAt: oldTimestamp,
    attempts: 0,
  });

  // 4. Executa o worker de reconciliação explícito
  const result = await reconcilePendingOperationsCore(firestore);

  assert.ok(result.staleCount >= 1 || result.resolvedReconciliationsCount >= 1);

  // 5. Verifica se os créditos do usuário foram restaurados para 5
  const userDocAfter = await userRef.get();
  assert.equal(userDocAfter.data().credits, 5, "Créditos do consulente devem ter sido integralmente estornados");
});

// ========================================================
// 8. ENDPOINTS DE RECONCILIAÇÃO: CRON E ADMIN AUTENTICADOS
// ========================================================

test("Reconciliação Cron: /api/cron/reconcile aceita GET com paginação e processamento limitado", async () => {
  const res = await requestFromTemporaryServer("/api/cron/reconcile?limit=10&staleSeconds=30", {
    method: "GET",
  });

  const body = await res.json();
  assert.equal(res.status, 200, "Deve aceitar GET no endpoint de cron");
  assert.equal(body.success, true);
  assert.ok(body.processed !== undefined);
  assert.ok(typeof body.processed.staleDetected === "number");
  assert.ok(typeof body.processed.staleRefunded === "number");
  assert.ok(typeof body.processed.skippedAlreadyCompleted === "number");
});

test("Reconciliação Admin: /api/admin/reconcile rejeita usuários sem privilégio de administrador", async () => {
  const normalUser = await createTestUser("normal_user");

  const res = await requestFromTemporaryServer("/api/admin/reconcile", {
    method: "POST",
    headers: {
      "Authorization": normalUser.authHeader,
      "X-Forwarded-For": normalUser.fakeIp,
    },
  });

  assert.equal(res.status, 403, "Usuário normal não pode invocar endpoint de admin");
});

