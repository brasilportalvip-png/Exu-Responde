import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

// Configuração restrita a este processo de teste. Nunca acessar Firebase real
// nem chamar Gemini com credenciais do ambiente local/Vercel.
Object.assign(process.env, {
  NODE_ENV: "test",
  VERCEL: "",
  VERCEL_ENV: "",
  FIREBASE_PROJECT_ID: "",
  FIREBASE_CLIENT_EMAIL: "",
  FIREBASE_PRIVATE_KEY: "",
  FIRESTORE_EMULATOR_HOST: "",
  GEMINI_API_KEY: "MY_GEMINI_API_KEY",
  API_KEY: "MY_GEMINI_API_KEY",
  ENFORCE_APP_CHECK: "false",
  CRON_SECRET: crypto.randomBytes(32).toString("hex"),
});

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

// Estes testes verificam consultas; cadastro e concessão do bônus precisam
// de testes próprios. Sem IP forjado, bypass de rate limit ou serviço real.
async function createTestUser(emailPrefix = "consulente") {
  const suffix = crypto.randomUUID();
  const uid = `uid_${suffix}`;
  const userId = `usr_${suffix}`;
  const email = `${emailPrefix}_${suffix}@example.invalid`;
  const user = {
    id: userId, firebaseUid: uid, email, emailVerified: true,
    name: "Consulente Teste", birthName: "Consulente Teste",
    birthDate: "1988-06-15", credits: 5, xp: 0, level: "Buscador",
    role: "user", isBlocked: false,
    createdAt: new Date().toISOString(),
  };
  await firestore.collection("users").doc(userId).set(user);
  const authHeader = `Bearer ${Buffer.from(
    JSON.stringify({ uid, email, email_verified: true })
  ).toString("base64")}`;
  assert.equal((await firestore.collection("users").doc(userId).get()).data().credits, 5);
  return { userId, user, authHeader, uid, email };
}

async function userLedger(userId) {
  return (await firestore.collection("credit_ledger")
    .where("userId", "==", userId).get()).docs.map(doc => doc.data());
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

      },
      body: JSON.stringify({
        question: "Caminhos de User B",
        slotsCount: 1,
        idempotencyKey: sharedKey,
      }),
    }),
  ]);

  for (const [res, user] of [[resA, userA], [resB, userB]]) {
    const body = await res.json();
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.refunded, true);
    const keyDoc = await firestore.collection("idempotency_keys")
      .doc(buildScopedIdempotencyDocId(user.userId, "tarot", sharedKey)).get();
    assert.equal(keyDoc.exists, true);
    assert.equal(keyDoc.data().userId, user.userId);
    assert.equal(keyDoc.data().status, "refunded");
    assert.equal((await firestore.collection("users").doc(user.userId).get()).data().credits, 5);
  }
  assert.notEqual(
    buildScopedIdempotencyDocId(userA.userId, "tarot", sharedKey),
    buildScopedIdempotencyDocId(userB.userId, "tarot", sharedKey)
  );
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

    },
    body: JSON.stringify({
      question: "Pergunta original sobre saúde",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });
  const body1 = await res1.json();
  assert.equal(res1.status, 503, JSON.stringify(body1));
  assert.equal(body1.refunded, true);

  // Segunda chamada com a MESMA chave mas pergunta DIFERENTE
  const res2 = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": user.authHeader,
      "Idempotency-Key": key,

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
  const ledger = await userLedger(user.userId);
  assert.equal(ledger.filter(row => row.type === "debit").length, 1);
  assert.equal(ledger.filter(row => row.type === "refund").length, 1);
  assert.equal((await firestore.collection("users").doc(user.userId).get()).data().credits, 5);
});

// ========================================================
// 2. CONSULTA COMPLETA E REPETIÇÃO DE RESPOSTA
// ========================================================

test("Repetição após resposta concluída: devolve resposta persistida sem novo débito e sem novo sorteio", async () => {
  const user = await createTestUser("repeat_user");
  const key = "key_repeat_" + crypto.randomUUID();
  const question = "Orientação espiritual para a semana";
  // Prepara uma consulta concluída pelo core real, sem depender de IA externa.
  const debit = await executeCreditDebitTransactionalCore(firestore, {
    userRef: firestore.collection("users").doc(user.userId),
    cost: 2, xpAwarded: 30, source: "tarot", consultationId: key,
    idempotencyKey: key,
    requestHash: computeRequestFingerprint({ question, slotsCount: 1 }),
  });
  const original = {
    success: true, drawn: [{ nome: "O Mago" }],
    interpretation: "Resposta de teste persistida.", creditsLeft: 3,
    xpAwarded: 30, newLevel: debit.newLevel,
  };
  await completeConsultationTransactionalCore(firestore, {
    userId: user.userId, source: "tarot", idempotencyKey: key,
    operationId: debit.operationId, responsePayload: original,
  });
  for (let repeat = 0; repeat < 2; repeat++) {
    const res = await requestFromTemporaryServer("/api/oraculo/tarot", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: user.authHeader, "Idempotency-Key": key },
      body: JSON.stringify({ question, slotsCount: 1, idempotencyKey: key }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { ...original, alreadyProcessed: true });
  }
  const savedUser = (await firestore.collection("users").doc(user.userId).get()).data();
  assert.equal(savedUser.credits, 3);
  assert.equal(savedUser.xp, 30);
  assert.equal((await userLedger(user.userId)).filter(row => row.type === "debit").length, 1);
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

      },
      body: JSON.stringify({
        question: "Abertura de caminhos",
        idempotencyKey: key,
      }),
    }),
  ]);

  const results = await Promise.all([res1.json(), res2.json()]);
  assert.deepEqual([res1.status, res2.status].sort(), [409, 503], JSON.stringify(results));
  const failure = results[[res1.status, res2.status].indexOf(503)];
  assert.equal(failure.refunded, true);
  const userAfter = (await firestore.collection("users").doc(user.userId).get()).data();
  assert.equal(userAfter.credits, 5, "Falha controlada deve devolver o saldo integral");
  assert.equal(userAfter.xp, 0);
  const ledger = await userLedger(user.userId);
  assert.equal(ledger.filter(row => row.type === "debit").length, 1, "Somente um débito");
  assert.equal(ledger.filter(row => row.type === "refund").length, 1, "Somente um estorno");
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

    },
    body: JSON.stringify({
      question: "Teste de falha de IA controlada",
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.refunded, true, "Estorno precisa estar confirmado");
  assert.equal(body.creditsLeft, 5);
  const userAfter = (await firestore.collection("users").doc(user.userId).get()).data();
  assert.equal(userAfter.credits, 5);
  assert.equal(userAfter.xp, 0);
  const ledger = await userLedger(user.userId);
  assert.equal(ledger.filter(row => row.type === "debit").length, 1);
  assert.equal(ledger.filter(row => row.type === "refund").length, 1);
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
  const res = await requestFromTemporaryServer("/api/cron/reconcile?limit=10&staleSeconds=120", {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
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

    },
  });

  assert.equal(res.status, 403, "Usuário normal não pode invocar endpoint de admin");
});


// Não confundir execução local de testes com acesso público ao agendador.
test("Reconciliação Cron: rejeita chamada sem token ou com token incorreto", async () => {
  for (const headers of [{}, { Authorization: "Bearer incorreto" }]) {
    const res = await requestFromTemporaryServer("/api/cron/reconcile", { headers });
    assert.equal(res.status, 401);
  }
});
