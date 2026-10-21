import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

// Carrega o bundle compilado da API
const {
  default: app,
  executeCreditDebitTransactionalCore,
  executeCreditRefundTransactionalCore,
  completeConsultationTransactionalCore,
  recoverStaleOperationTransactionalCore,
  reconcilePendingOperationsCore,
  buildScopedIdempotencyDocId,
  computeRequestFingerprint,
  getAppFirestore,
} = require("../dist/api.test.cjs");

// Obtém a instância de Firestore configurada
const firestore = getAppFirestore();

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

async function createEmulatorUser(initialCredits = 5, initialXp = 100) {
  const timestamp = Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  const userId = `usr_emu_${timestamp}`;
  const userRef = firestore.collection("users").doc(userId);

  await userRef.set({
    id: userId,
    birthName: `Consulente Emulador ${timestamp}`,
    birthDate: "1990-05-20",
    email: `consulente_${timestamp}@teste.com`,
    credits: initialCredits,
    xp: initialXp,
    level: "Buscador",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const authHeader = `Bearer ${Buffer.from(
    JSON.stringify({ uid: `uid_${timestamp}`, email: `consulente_${timestamp}@teste.com`, email_verified: true })
  ).toString("base64")}`;

  return {
    userId,
    userRef,
    authHeader,
    fakeIp: "127.0.0.1",
  };
}

// =========================================================================
// 1. CORRIDA: CONCLUSÃO ENTRE A SELEÇÃO DA OPERAÇÃO ANTIGA E SEU ESTORNO
// =========================================================================
test("Emulator - Corrida: consulta que conclui após seleção stale NÃO deve ser estornada pela reconciliação", async () => {
  const { userId, userRef } = await createEmulatorUser(5, 100);
  const idempotencyKey = "key_race_complete_" + Date.now();
  const cost = 2;
  const xpAwarded = 25;

  // 1. Executa o débito da consulta
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost,
    xpAwarded,
    source: "tarot",
    consultationId: "cons_race_" + Date.now(),
    idempotencyKey,
  });

  assert.equal(debitRes.balanceAfter, 3, "Saldo deve ter sido debitado de 5 para 3");
  const scopedId = buildScopedIdempotencyDocId(userId, "tarot", idempotencyKey);
  const keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);

  // 2. Simula que a operação ficou stale no banco (> 60s atrás)
  const oldIso = new Date(Date.now() - 120_000).toISOString();
  await keyDocRef.update({
    createdAt: oldIso,
    updatedAt: oldIso,
  });

  // 3. Simula a corrida: o oráculo termina e CONCLUI a consulta antes que o worker de reconciliação execute o estorno
  const expectedResponse = {
    oracle: "tarot",
    drawnCards: ["O Sol", "A Estrela"],
    interpretation: "Caminhos de luz e abertura espiritual confirmados pelos ancestrais.",
    creditsLeft: 3,
  };

  await completeConsultationTransactionalCore(firestore, {
    userId,
    source: "tarot",
    idempotencyKey,
    operationId: debitRes.operationId,
    responsePayload: expectedResponse,
  });

  // Verifica que o documento está 'completed'
  const keySnapAfterComplete = await keyDocRef.get();
  assert.equal(keySnapAfterComplete.data().status, "completed");

  // 4. O worker de reconciliação tenta processar a operação stale que havia sido selecionada
  const recovery = await recoverStaleOperationTransactionalCore(firestore, {
    keyDocId: scopedId,
    expectedOperationId: debitRes.operationId,
    expectedUserId: userId,
    staleTimeoutMs: 60_000,
    reason: "Tentativa de estorno de seleção stale antiga",
  });

  // 5. VERIFICAÇÕES OBRIGATÓRIAS:
  // O estorno foi ABORTADO porque a transação detectou que a consulta já estava 'completed'
  assert.equal(recovery.resolved, false, "Recuperação não deve executar estorno");
  assert.equal(recovery.reason, "already_completed", "Motivo deve ser already_completed");

  // O saldo do consulente continua exatamente 3 (NÃO foi indevidamente estornado)
  const userDocFinal = await userRef.get();
  assert.equal(userDocFinal.data().credits, 3, "Saldo deve permanecer em 3 créditos");
  assert.equal(userDocFinal.data().xp, 125, "XP deve permanecer em 125");

  // A resposta persistida continua intacta e inalterada
  const keySnapFinal = await keyDocRef.get();
  assert.equal(keySnapFinal.data().status, "completed");
  assert.deepEqual(keySnapFinal.data().persistedResponse, expectedResponse, "Resposta deve ser preservada");

  // Nenhum estorno foi gravado no livro-razão (ledger)
  const ledgerSnap = await firestore
    .collection("credit_ledger")
    .where("originalOperationId", "==", debitRes.operationId)
    .get();
  assert.equal(ledgerSnap.empty, true, "Não deve existir registro de estorno no ledger");
});

// =========================================================================
// 2. PROCESSOS ATRASADOS E REUTILIZAÇÃO DE CHAVE
// =========================================================================
test("Emulator - Processo atrasado: execução antiga após estorno é recusada e chave estornada bloqueia reuso", async () => {
  const { userId, userRef } = await createEmulatorUser(5, 100);
  const idempotencyKey = "key_delayed_process_" + Date.now();
  const scopedId = buildScopedIdempotencyDocId(userId, "tarot", idempotencyKey);
  const keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);

  // 1. Débito da operação 1 (que irá atrasar/falhar)
  const debit1 = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "cons_delayed_" + Date.now(),
    idempotencyKey,
  });

  assert.equal(debit1.balanceAfter, 3);

  // 2. A operação é estornada legitimamente por timeout/reconciliação
  const oldIso = new Date(Date.now() - 120_000).toISOString();
  await keyDocRef.update({ createdAt: oldIso });

  const recovery = await recoverStaleOperationTransactionalCore(firestore, {
    keyDocId: scopedId,
    expectedOperationId: debit1.operationId,
    expectedUserId: userId,
    staleTimeoutMs: 60_000,
    reason: "Estorno de operação atrasada",
  });

  assert.equal(recovery.resolved, true);
  assert.equal(recovery.reason, "refunded_successfully");

  // Saldo restaurado para 5
  const userDocAfterRefund = await userRef.get();
  assert.equal(userDocAfterRefund.data().credits, 5);

  // 3. O PROCESSO ATRASADO de debit1 acorda após o estorno e tenta concluir
  let threwCompletion = false;
  try {
    await completeConsultationTransactionalCore(firestore, {
      userId,
      source: "tarot",
      idempotencyKey,
      operationId: debit1.operationId, // Processo antigo
      responsePayload: { ghost: true },
    });
  } catch (err) {
    threwCompletion = true;
    assert.match(err.message, /já foi estornad[ao]/i);
    assert.equal(err.code, "OPERATION_ALREADY_REFUNDED");
  }
  assert.equal(threwCompletion, true, "Processo atrasado deve ser explicitamente recusado");

  // 4. Documento no banco continua 'refunded', NUNCA sobrescrito para 'completed'
  const keySnap = await keyDocRef.get();
  assert.equal(keySnap.data().status, "refunded");
  assert.equal(keySnap.data().persistedResponse, undefined, "Não pode gravar resposta de processo zumbi");

  // 5. Tentativa de reusar a MESMA chave estornada é expressamente rejeitada (imunidade a colisões)
  let threwKeyReuse = false;
  try {
    await executeCreditDebitTransactionalCore(firestore, {
      userRef,
      cost: 2,
      xpAwarded: 25,
      source: "tarot",
      consultationId: "cons_reuse_" + Date.now(),
      idempotencyKey, // Mesma chave já estornada
    });
  } catch (err) {
    threwKeyReuse = true;
    assert.equal(err.status, 409);
    assert.equal(err.code, "KEY_ALREADY_REFUNDED");
  }
  assert.equal(threwKeyReuse, true, "Chave estornada não pode ser reaberta com novo débito");

  // 6. Nova consulta com NOVA chave funciona perfeitamente sem qualquer interferência
  const freshKey = "key_fresh_" + Date.now();
  const debit2 = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "cons_fresh_" + Date.now(),
    idempotencyKey: freshKey,
  });

  assert.notEqual(debit2.operationId, debit1.operationId, "Novo débito deve ter operação isolada");
  assert.equal(debit2.balanceAfter, 3);

  // Conclui debit2 normalmente
  await completeConsultationTransactionalCore(firestore, {
    userId,
    source: "tarot",
    idempotencyKey: freshKey,
    operationId: debit2.operationId,
    responsePayload: { success: true, fresh: true },
  });

  const freshSnap = await firestore
    .collection("idempotency_keys")
    .doc(buildScopedIdempotencyDocId(userId, "tarot", freshKey))
    .get();
  assert.equal(freshSnap.data().status, "completed");
});

// =========================================================================
// 3. FALHA AO PERSISTIR A RESPOSTA (PERSISTÊNCIA ESSENCIAL & ESTORNO)
// =========================================================================
test("Emulator - Falha de persistência: falha ao salvar resposta essencial executa estorno e não declara sucesso", async () => {
  const { userId, userRef, authHeader, fakeIp } = await createEmulatorUser(5, 100);
  const key = "key_persist_fail_" + Date.now();
  const scopedId = buildScopedIdempotencyDocId(userId, "tarot", key);

  // Executa débito inicial direto
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "cons_fail_persist_" + Date.now(),
    idempotencyKey: key,
  });

  assert.equal(debitRes.balanceAfter, 3, "Saldo debitado para 3");

  // Simula que a chave foi deletada ou o ID divergiu para forçar erro em completeConsultationTransactionalCore
  let persistThrew = false;
  try {
    await completeConsultationTransactionalCore(firestore, {
      userId,
      source: "tarot",
      idempotencyKey: key,
      operationId: "op_fake_mismatch_" + Date.now(), // Divergência proposital de operationId
      responsePayload: { carta: "O Louco" },
    });
  } catch (err) {
    persistThrew = true;
    assert.equal(err.code, "OPERATION_ID_MISMATCH");
  }
  assert.equal(persistThrew, true, "Persistência essencial deve falhar em caso de inconsistência");

  // O fluxo deve executar o estorno imediato
  const refundRes = await executeCreditRefundTransactionalCore(firestore, {
    userRef,
    amount: 2,
    originalOperationId: debitRes.operationId,
    source: "tarot",
    reason: "Estorno automático: falha essencial ao persistir resposta",
    idempotencyKey: key,
  });

  assert.equal(refundRes.balanceAfter, 5, "Saldo deve retornar a 5");
  assert.equal(refundRes.newXp, 100, "XP deve retornar a 100");

  // Confere no Firestore Emulator que a operação original está 'refunded'
  const origDoc = await firestore.collection("credit_ledger").doc(debitRes.operationId).get();
  assert.equal(origDoc.data().status, "refunded");
  assert.ok(origDoc.data().refundOperationId);
});

// =========================================================================
// 4. CONCORRÊNCIA DE DÉBITOS E ESTORNOS (NUNCA NEGATIVO, NÃO DUPLICA)
// =========================================================================
test("Emulator - Concorrência: débitos simultâneos respeitam saldo no Firestore Emulator e estornos não duplicam", async () => {
  // Usuário começa com 5 créditos; cada operação custa 2 créditos.
  // No máximo 2 débitos podem ter sucesso (5 - 4 = 1).
  const { userId, userRef } = await createEmulatorUser(5, 100);

  // Dispara 5 débitos concorrentes
  const results = await Promise.allSettled(
    Array.from({ length: 5 }).map((_, i) =>
      executeCreditDebitTransactionalCore(firestore, {
        userRef,
        cost: 2,
        xpAwarded: 25,
        source: "buzios",
        consultationId: `conc_deb_${i}_` + Date.now(),
        idempotencyKey: `conc_key_${i}_` + Date.now(),
      })
    )
  );

  const successful = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const rejected = results.filter((r) => r.status === "rejected").map((r) => r.reason);

  assert.equal(successful.length, 2, "Apenas 2 débitos devem ser aceitos com 5 créditos");
  assert.equal(rejected.length, 3, "3 débitos devem ser rejeitados por saldo insuficiente");

  for (const err of rejected) {
    assert.equal(err.status, 402, "Erro deve ser 402 Insufficient credits");
  }

  // Verifica saldo final no Firestore Emulator: deve ser EXATAMENTE 1 (5 - 2*2 = 1)
  const userDocFinal = await userRef.get();
  assert.equal(userDocFinal.data().credits, 1, "Saldo final deve ser exatamente 1 crédito");
  assert.equal(userDocFinal.data().xp, 150, "XP deve ser 100 + 25*2 = 150");

  // Agora testa estorno simultâneo do primeiro débito aceito
  const opToRefund = successful[0].operationId;
  const [ref1, ref2] = await Promise.all([
    executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 2,
      originalOperationId: opToRefund,
      source: "buzios",
      reason: "Estorno concorrente 1",
    }),
    executeCreditRefundTransactionalCore(firestore, {
      userRef,
      amount: 2,
      originalOperationId: opToRefund,
      source: "buzios",
      reason: "Estorno concorrente 2",
    }),
  ]);

  const refundFlags = [ref1.alreadyRefunded, ref2.alreadyRefunded].sort();
  assert.deepEqual(refundFlags, [false, true], "Apenas um estorno deve executar");

  // Saldo deve subir de 1 para 3 (devolveu 2 créditos uma única vez)
  const userDocAfterRefund = await userRef.get();
  assert.equal(userDocAfterRefund.data().credits, 3, "Saldo deve ser 1 + 2 = 3 créditos");
  assert.equal(userDocAfterRefund.data().xp, 125, "XP deve ser 150 - 25 = 125");
});

// =========================================================================
// 5. REPETIÇÃO DE CONSULTA CONCLUÍDA SEM NOVA GERAÇÃO OU COBRANÇA
// =========================================================================
test("Emulator - Repetição: consulta concluída devolve resposta persistida sem novo débito e sem novo sorteio", async () => {
  const { userId, userRef, authHeader, fakeIp } = await createEmulatorUser(5, 100);
  const key = "key_repeat_complete_" + Date.now();
  const question = "Caminhos e orientações para os negócios";
  const requestHash = computeRequestFingerprint({ question, slotsCount: 1 });

  // 1. Simula que a consulta foi debitada e concluída anteriormente
  const debitRes = await executeCreditDebitTransactionalCore(firestore, {
    userRef,
    cost: 2,
    xpAwarded: 25,
    source: "tarot",
    consultationId: "cons_tarot_rep_" + Date.now(),
    idempotencyKey: key,
    requestHash,
  });

  assert.equal(debitRes.balanceAfter, 3, "Saldo deve ter sido debitado de 5 para 3");

  const persistedResponsePayload = {
    success: true,
    drawn: [{ nome: "O Sol", arcano: "Maior", regente: "Oxalá" }],
    interpretation: "Caminhos abertos e clareza ancestral confirmada.",
    creditsLeft: 3,
    xpAwarded: 25,
    newLevel: "Buscador",
  };

  await completeConsultationTransactionalCore(firestore, {
    userId,
    source: "tarot",
    idempotencyKey: key,
    operationId: debitRes.operationId,
    responsePayload: persistedResponsePayload,
  });

  // Confere que há exatamente 1 débito no ledger
  const ledgerSnap1 = await firestore
    .collection("credit_ledger")
    .where("userId", "==", userId)
    .where("type", "==", "debit")
    .get();
  assert.equal(ledgerSnap1.docs.length, 1, "Exatamente 1 débito inicial no ledger");

  // 2. Repetição idêntica via endpoint HTTP com a mesma chave e mesma pergunta
  const res = await requestFromTemporaryServer("/api/oraculo/tarot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authHeader,
      "Idempotency-Key": key,
      "X-Forwarded-For": fakeIp,
    },
    body: JSON.stringify({
      question,
      slotsCount: 1,
      idempotencyKey: key,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 200, "Deve retornar 200 OK");
  assert.equal(body.alreadyProcessed, true, "Deve conter flag alreadyProcessed: true");
  assert.equal(body.drawn[0].nome, "O Sol", "A carta DEVE ser rigorosamente a mesma da resposta persistida");
  assert.equal(body.interpretation, persistedResponsePayload.interpretation, "A interpretação DEVE ser a mesma");
  assert.equal(body.creditsLeft, 3, "Não deve haver novo débito de créditos");

  // Confere que NENHUM novo débito foi inserido no livro-razão (ledger)
  const ledgerSnap2 = await firestore
    .collection("credit_ledger")
    .where("userId", "==", userId)
    .where("type", "==", "debit")
    .get();
  assert.equal(ledgerSnap2.docs.length, 1, "Não pode haver novo débito no ledger em repetição");

  // Confere no banco real do emulador que o usuário continua com saldo 3 e XP 125
  const userDocFinal = await userRef.get();
  assert.equal(userDocFinal.data().credits, 3, "Saldo no banco deve permanecer 3");
  assert.equal(userDocFinal.data().xp, 125, "XP no banco deve permanecer 125");
});
