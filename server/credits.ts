import crypto from "node:crypto";

export interface CreditLedgerRecord {
  operationId: string;
  idempotencyKey?: string;
  userId: string;
  firebaseUid?: string;
  type: "debit" | "grant" | "refund" | "purchase" | "payment" | "adjustment";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  xpAwarded?: number;
  xpBefore?: number;
  xpAfter?: number;
  levelBefore?: string;
  levelAfter?: string;
  status: "processing" | "committed" | "reversed" | "refunded" | "failed";
  source: "chat" | "tarot" | "numerologia" | "buzios" | "registration" | "mercadopago" | "admin" | "astrologia";
  consultationId?: string;
  originalOperationId?: string;
  refundOperationId?: string;
  paymentId?: string;
  orderId?: string;
  adminId?: string;
  reason?: string;
  createdAt: string;
  committedAt?: string;
  reversedAt?: string;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  scopedDocId: string;
  userId: string;
  source: CreditLedgerRecord["source"];
  requestHash?: string;
  requestPayloadSummary?: string;
  operationId: string;
  consultationId?: string;
  status: "processing" | "completed" | "refunded" | "failed";
  cost: number;
  balanceBefore: number;
  balanceAfter: number;
  newXp: number;
  newLevel: string;
  xpAwarded: number;
  persistedResponse?: any;
  refundOperationId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  refundedAt?: string;
}

export function calculateSpiritualLevel(xp: number): { level: string; nextThreshold: number } {
  if (xp < 200) return { level: "Buscador", nextThreshold: 200 };
  if (xp < 500) return { level: "Aprendiz", nextThreshold: 500 };
  if (xp < 1200) return { level: "Peregrino", nextThreshold: 1200 };
  if (xp < 2500) return { level: "Iniciado", nextThreshold: 2500 };
  if (xp < 5000) return { level: "Guardião", nextThreshold: 5000 };
  if (xp < 8000) return { level: "Conhecedor", nextThreshold: 8000 };
  return { level: "Mestre dos Caminhos", nextThreshold: 8000 };
}

export function getSpiritualLevelName(xp: number): string {
  return calculateSpiritualLevel(xp).level;
}

// ======================================================
// RATE LIMITING ATÔMICO COM FIRESTORE TRANSACTION + TTL
// ======================================================
const inMemoryRateLimits = new Map<string, number[]>();

export async function checkAtomicDurableRateLimit(
  firestore: any,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  const now = Date.now();

  // 1. Defesa rápida em memória (sliding window local)
  const timestamps = inMemoryRateLimits.get(key) || [];
  const validTimestamps = timestamps.filter((t) => now - t < windowMs);

  if (validTimestamps.length >= maxRequests) {
    return false;
  }
  validTimestamps.push(now);
  inMemoryRateLimits.set(key, validTimestamps);

  // 2. Transação Atômica no Firestore para consistência distribuída
  if (!firestore) return true;

  try {
    const keyHash = crypto.createHash("sha256").update(key).digest("hex").substring(0, 32);
    const windowSlot = Math.floor(now / windowMs);
    const docId = `rl_${keyHash}_${windowSlot}`;
    const docRef = firestore.collection("rate_limits").doc(docId);

    const allowed = await firestore.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(docRef);

      if (!snap.exists) {
        transaction.set(docRef, {
          count: 1,
          windowSlot,
          expiresAt: new Date(now + windowMs * 2).toISOString(),
          createdAt: new Date(now).toISOString(),
        });
        return true;
      }

      const data = snap.data() || {};
      const currentCount = Number(data.count || 0);

      if (currentCount >= maxRequests) {
        return false;
      }

      transaction.update(docRef, {
        count: currentCount + 1,
        updatedAt: new Date(now).toISOString(),
      });
      return true;
    });

    return allowed;
  } catch (err) {
    console.warn("[RATE-LIMIT] Fallback de Firestore para in-memory:", err);
    return true;
  }
}

// ======================================================
// UTILITÁRIOS DE IDENTIFICAÇÃO E IDEMPOTÊNCIA
// ======================================================
export function buildScopedIdempotencyDocId(
  userId: string,
  source: string,
  idempotencyKey: string
): string {
  const sanitizedKey = (idempotencyKey || "")
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, "")
    .substring(0, 128);
  const keyHash = crypto.createHash("sha256").update(sanitizedKey).digest("hex").substring(0, 32);
  const userClean = (userId || "anon").trim().replace(/[^a-zA-Z0-9_\-]/g, "").substring(0, 48);
  const sourceClean = (source || "unknown").trim().replace(/[^a-zA-Z0-9_\-]/g, "").substring(0, 24);
  return `idem_${userClean}_${sourceClean}_${keyHash}`;
}

export function computeRequestFingerprint(payload: any): string {
  if (!payload || typeof payload !== "object") {
    return crypto.createHash("sha256").update(String(payload || "")).digest("hex");
  }
  const sortedKeys = Object.keys(payload).sort();
  const canonicalObj: Record<string, any> = {};
  for (const k of sortedKeys) {
    const val = payload[k];
    if (typeof val === "string") {
      canonicalObj[k] = val.trim();
    } else {
      canonicalObj[k] = val;
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(canonicalObj)).digest("hex");
}

// ======================================================
// DÉBITO TRANSACIONAL COM ISOLAMENTO DE USUÁRIO E CONTEÚDO
// ======================================================
export interface DebitParams {
  userRef: any;
  cost: number;
  xpAwarded: number;
  source: CreditLedgerRecord["source"];
  consultationId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  requestPayloadSummary?: string;
}

export interface DebitResult {
  isAlreadyCommitted: boolean;
  operationId: string;
  balanceBefore: number;
  balanceAfter: number;
  newXp: number;
  newLevel: string;
  xpAwarded: number;
  persistedResponse?: any;
  status: "processing" | "completed";
}

export async function executeCreditDebitTransactional(
  firestore: any,
  params: DebitParams
): Promise<DebitResult> {
  const now = new Date().toISOString();
  const rawKey = params.idempotencyKey?.trim() || "";
  const sanitizedKey = rawKey ? rawKey.replace(/[^a-zA-Z0-9_\-]/g, "").substring(0, 128) : "";

  // Identificador isolado por usuário e modalidade de consulta
  const targetUserId = params.userRef?.id || "";
  const scopedKeyDocId = sanitizedKey && targetUserId
    ? buildScopedIdempotencyDocId(targetUserId, params.source, sanitizedKey)
    : "";
  const keyDocRef = scopedKeyDocId && firestore
    ? firestore.collection("idempotency_keys").doc(scopedKeyDocId)
    : null;

  return firestore.runTransaction(async (transaction: any) => {
    // ==========================================
    // FASE 1: TODAS AS LEITURAS PRIMEIRO (STRICT READS)
    // ==========================================

    let keySnap: any = null;
    if (keyDocRef) {
      keySnap = await transaction.get(keyDocRef);
    }

    const userDoc = await transaction.get(params.userRef);
    if (!userDoc.exists) {
      const err: any = new Error("Usuário não encontrado.");
      err.status = 404;
      throw err;
    }

    // ==========================================
    // VALIDAÇÃO DAS LEITURAS (SEM NENHUM WRITE AINDA)
    // ==========================================
    const userData = userDoc.data() || {};
    const currentCredits = Number(userData.credits || 0);
    const currentXp = Number(userData.xp || 0);

    if (keySnap && keySnap.exists) {
      const keyData = keySnap.data() || {};

      // 1. Validação de isolamento de usuário: chave não pode ser reutilizada por outro usuário
      if (keyData.userId && keyData.userId !== userDoc.id) {
        const err: any = new Error("Chave de idempotência vinculada a outro usuário.");
        err.status = 409;
        throw err;
      }

      // 2. Validação de modalidade: mesma chave com modalidade diferente gera conflito
      if (keyData.source && keyData.source !== params.source) {
        const err: any = new Error(
          `Chave de idempotência reutilizada para modalidade diferente (${keyData.source} vs ${params.source}).`
        );
        err.status = 409;
        throw err;
      }

      // 3. Validação de conteúdo da requisição: reutilizar a mesma chave com outra pergunta gera conflito
      if (params.requestHash && keyData.requestHash && keyData.requestHash !== params.requestHash) {
        const err: any = new Error(
          "Chave de idempotência reutilizada com pergunta ou parâmetros diferentes da consulta original."
        );
        err.status = 409;
        throw err;
      }

      // 4. Se a consulta já foi concluída, devolve a resposta persistida sem novo débito e sem novo XP
      if (keyData.status === "completed") {
        return {
          isAlreadyCommitted: true,
          operationId: keyData.operationId,
          balanceBefore: keyData.balanceBefore ?? currentCredits,
          balanceAfter: keyData.balanceAfter ?? currentCredits,
          newXp: keyData.newXp ?? currentXp,
          newLevel: keyData.newLevel ?? (userData.level || "Buscador"),
          xpAwarded: 0,
          persistedResponse: keyData.persistedResponse,
          status: "completed",
        };
      }

      // 5. Se está em processamento concorrente:
      if (keyData.status === "processing") {
        const createdAtMs = new Date(keyData.createdAt || 0).getTime();
        const isStale = Date.now() - createdAtMs > 60_000; // 60 segundos de timeout
        if (!isStale) {
          const err: any = new Error(
            "Uma consulta idêntica já está em processamento no terreiro. Aguarde a conclusão."
          );
          err.status = 409;
          err.code = "OPERATION_IN_PROGRESS";
          throw err;
        }
        // Se a operação ficou presa (> 60s), sinaliza para recuperação
        const err: any = new Error(
          "Operação anterior foi interrompida antes da conclusão. Aguarde o estorno automático ou tente com nova consulta."
        );
        err.status = 409;
        err.code = "STALE_OPERATION_PENDING_RECOVERY";
        throw err;
      }
    }

    // Validação de saldo
    if (currentCredits < params.cost) {
      const err: any = new Error(
        `Saldo insuficiente (${currentCredits} Axé disponível, necessário ${params.cost}).`
      );
      err.status = 402;
      err.available = currentCredits;
      throw err;
    }

    const balanceAfter = currentCredits - params.cost;
    const newXp = currentXp + params.xpAwarded;
    const levelBefore = userData.level || "Buscador";
    const newLevel = getSpiritualLevelName(newXp);
    const operationId = "op_deb_" + crypto.randomUUID();

    // ==========================================
    // FASE 2: TODAS AS ESCRITAS (APENAS APÓS TODAS AS LEITURAS)
    // ==========================================

    // 1. Atualiza usuário atomicamente
    transaction.update(params.userRef, {
      credits: balanceAfter,
      xp: newXp,
      level: newLevel,
      updatedAt: now,
    });

    // 2. Grava ledger de auditoria imutável (status inicial: committed)
    const ledgerRef = firestore.collection("credit_ledger").doc(operationId);
    transaction.set(ledgerRef, {
      operationId,
      idempotencyKey: sanitizedKey || operationId,
      userId: userDoc.id,
      firebaseUid: userData.firebaseUid || "",
      type: "debit",
      amount: params.cost,
      balanceBefore: currentCredits,
      balanceAfter,
      xpBefore: currentXp,
      xpAfter: newXp,
      xpAwarded: params.xpAwarded,
      levelBefore,
      levelAfter: newLevel,
      status: "committed",
      source: params.source,
      consultationId: params.consultationId || "",
      createdAt: now,
      committedAt: now,
    });

    // 3. Grava chave de idempotência com status "processing"
    if (keyDocRef) {
      transaction.set(keyDocRef, {
        idempotencyKey: sanitizedKey,
        scopedDocId: scopedKeyDocId,
        userId: userDoc.id,
        source: params.source,
        requestHash: params.requestHash || "",
        requestPayloadSummary: params.requestPayloadSummary || "",
        operationId,
        consultationId: params.consultationId || "",
        cost: params.cost,
        balanceBefore: currentCredits,
        balanceAfter,
        newXp,
        newLevel,
        xpAwarded: params.xpAwarded,
        status: "processing",
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      isAlreadyCommitted: false,
      operationId,
      balanceBefore: currentCredits,
      balanceAfter,
      newXp,
      newLevel,
      xpAwarded: params.xpAwarded,
      status: "processing",
    };
  });
}

// ======================================================
// PERSISTÊNCIA DA RESPOSTA COMPLETA DA CONSULTA
// ======================================================
export async function completeConsultationTransactional(
  firestore: any,
  params: {
    userId: string;
    source: CreditLedgerRecord["source"];
    idempotencyKey?: string;
    operationId: string;
    responsePayload: any;
  }
): Promise<void> {
  if (!params.idempotencyKey || !firestore) return;
  const now = new Date().toISOString();
  const scopedId = buildScopedIdempotencyDocId(params.userId, params.source, params.idempotencyKey);
  const keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);

  await firestore.runTransaction(async (transaction: any) => {
    // 1. Leitura
    const keySnap = await transaction.get(keyDocRef);

    if (!keySnap.exists) {
      // Cria registro como completed se não existia
      transaction.set(keyDocRef, {
        idempotencyKey: params.idempotencyKey,
        scopedDocId: scopedId,
        userId: params.userId,
        source: params.source,
        operationId: params.operationId,
        status: "completed",
        persistedResponse: params.responsePayload,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
      return;
    }

    const keyData = keySnap.data() || {};
    // Se a consulta foi estornada concorrentemente, não sobrescreve com status completed
    if (keyData.status === "refunded") {
      console.warn(
        `[CONSULTATION] Operação ${params.operationId} já está estornada. Resposta descartada do cache.`
      );
      return;
    }

    // 2. Escrita
    transaction.update(keyDocRef, {
      status: "completed",
      persistedResponse: params.responsePayload,
      completedAt: now,
      updatedAt: now,
    });
  });
}

// ======================================================
// ESTORNO TRANSACIONAL RIGOROSO (REVERSÃO DE CRÉDITO, XP E NÍVEL)
// ======================================================
export interface RefundResult {
  operationId: string;
  balanceAfter: number;
  newXp: number;
  newLevel: string;
  alreadyRefunded: boolean;
  refundedAmount: number;
}

export async function executeCreditRefundTransactional(
  firestore: any,
  params: {
    userRef: any;
    amount?: number;
    originalOperationId: string;
    source: CreditLedgerRecord["source"];
    reason: string;
    idempotencyKey?: string;
  }
): Promise<RefundResult> {
  if (!params.originalOperationId || typeof params.originalOperationId !== "string") {
    const err: any = new Error("Identificador da operação original é obrigatório para estorno.");
    err.status = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const refundOpId = "op_ref_" + crypto.randomUUID();

  return firestore.runTransaction(async (transaction: any) => {
    // ==========================================
    // FASE 1: TODAS AS LEITURAS PRIMEIRO (STRICT READS)
    // ==========================================

    // 1. Busca operação original no ledger
    const origDocRef = firestore.collection("credit_ledger").doc(params.originalOperationId);
    const origDoc = await transaction.get(origDocRef);

    if (!origDoc.exists) {
      const err: any = new Error(
        `Operação original de débito '${params.originalOperationId}' não encontrada para estorno.`
      );
      err.status = 404;
      throw err;
    }

    const origData = origDoc.data() as CreditLedgerRecord;

    // 2. Lê usuário atomicamente
    const userDoc = await transaction.get(params.userRef);
    if (!userDoc.exists) {
      const err: any = new Error("Usuário não encontrado para efetuar estorno.");
      err.status = 404;
      throw err;
    }

    // 3. Lê o documento de idempotência associado se existir
    let keyDocRef: any = null;
    let keySnap: any = null;
    const effectiveIdempotencyKey = origData.idempotencyKey || params.idempotencyKey;
    if (effectiveIdempotencyKey) {
      const scopedId = buildScopedIdempotencyDocId(
        userDoc.id,
        origData.source || params.source,
        effectiveIdempotencyKey
      );
      keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);
      keySnap = await transaction.get(keyDocRef);
    }

    // ==========================================
    // VALIDAÇÕES DAS LEITURAS (SEM NENHUM WRITE AINDA)
    // ==========================================

    // Validação 1: Operação original deve ser do tipo "debit"
    if (origData.type !== "debit") {
      const err: any = new Error(
        `Operação original não é um débito válido (tipo encontrado: '${origData.type}'). Estorno rejeitado.`
      );
      err.status = 400;
      throw err;
    }

    // Validação 2: Operação deve pertencer ao mesmo usuário autenticado
    if (origData.userId && origData.userId !== userDoc.id) {
      const err: any = new Error(
        "Operação original pertence a outro consulente. Estorno não autorizado."
      );
      err.status = 403;
      throw err;
    }

    // Validação 3: Derivar valor do estorno do débito original e rejeitar divergências
    const originalDebitAmount = Number(origData.amount || 0);
    if (originalDebitAmount <= 0) {
      const err: any = new Error("Valor do débito original é inválido (zero ou negativo).");
      err.status = 400;
      throw err;
    }

    if (
      params.amount !== undefined &&
      params.amount !== null &&
      Number(params.amount) !== originalDebitAmount
    ) {
      const err: any = new Error(
        `Valor do estorno solicitado (${params.amount}) diverge do valor debitado originalmente (${originalDebitAmount}).`
      );
      err.status = 400;
      throw err;
    }

    const userData = userDoc.data() || {};

    // Validação 4: Idempotência de estorno / Proteção contra duplo estorno simultâneo
    if (origData.status === "refunded" || origData.status === "reversed") {
      console.warn(
        `[REFUND] Operação original ${params.originalOperationId} já foi estornada anteriormente.`
      );
      return {
        operationId: origData.refundOperationId || params.originalOperationId,
        balanceAfter: Number(userData.credits || 0),
        newXp: Number(userData.xp || 0),
        newLevel: userData.level || "Buscador",
        alreadyRefunded: true,
        refundedAmount: originalDebitAmount,
      };
    }

    const xpToRevert = Number(origData.xpAwarded || 0);
    const currentCredits = Number(userData.credits || 0);
    const currentXp = Number(userData.xp || 0);

    const balanceAfter = currentCredits + originalDebitAmount;
    const newXp = Math.max(0, currentXp - xpToRevert);
    const newLevel = getSpiritualLevelName(newXp);

    // ==========================================
    // FASE 2: TODAS AS ESCRITAS (APENAS APÓS TODAS AS LEITURAS)
    // ==========================================

    // 1. Marca a operação original como estornada
    transaction.update(origDocRef, {
      status: "refunded",
      reversedAt: now,
      refundOperationId: refundOpId,
    });

    // 2. Atualiza saldo, XP e nível do usuário
    transaction.update(params.userRef, {
      credits: balanceAfter,
      xp: newXp,
      level: newLevel,
      updatedAt: now,
    });

    // 3. Cria registro imutável de refund no livro-razão (ledger)
    const refundRef = firestore.collection("credit_ledger").doc(refundOpId);
    transaction.set(refundRef, {
      operationId: refundOpId,
      originalOperationId: params.originalOperationId,
      userId: userDoc.id,
      firebaseUid: userData.firebaseUid || "",
      type: "refund",
      amount: originalDebitAmount,
      balanceBefore: currentCredits,
      balanceAfter,
      xpBefore: currentXp,
      xpAfter: newXp,
      xpAwarded: -xpToRevert,
      levelBefore: userData.level || "Buscador",
      levelAfter: newLevel,
      status: "refunded",
      source: params.source || origData.source,
      reason: params.reason,
      createdAt: now,
      committedAt: now,
    });

    // 4. Atualiza registro de idempotência para status 'refunded'
    if (keyDocRef && keySnap && keySnap.exists) {
      transaction.update(keyDocRef, {
        status: "refunded",
        refundOperationId: refundOpId,
        refundedAt: now,
        updatedAt: now,
      });
    }

    return {
      operationId: refundOpId,
      balanceAfter,
      newXp,
      newLevel,
      alreadyRefunded: false,
      refundedAmount: originalDebitAmount,
    };
  });
}

// ======================================================
// ESTRATÉGIA DE RECUPERAÇÃO E RECONCILIAÇÃO EXPLÍCITA
// ======================================================
export interface ReconcileResult {
  staleCount: number;
  refundedCount: number;
  resolvedReconciliationsCount: number;
  errors: string[];
}

export async function reconcilePendingOperations(firestore: any): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    staleCount: 0,
    refundedCount: 0,
    resolvedReconciliationsCount: 0,
    errors: [],
  };

  if (!firestore) return result;

  const nowMs = Date.now();
  const staleThresholdIso = new Date(nowMs - 60_000).toISOString();

  // 1. Processa fila de reconciliações pendentes
  try {
    const recSnap = await firestore
      .collection("reconciliations")
      .where("status", "==", "reconciliation_required")
      .limit(50)
      .get();

    for (const doc of recSnap.docs) {
      const recData = doc.data();
      try {
        const userRef = firestore.collection("users").doc(recData.userId);
        const refundRes = await executeCreditRefundTransactional(firestore, {
          userRef,
          amount: recData.creditsCost || recData.amount,
          originalOperationId: recData.operationId,
          source: recData.source || "chat",
          reason: `Reconciliação automática: ${recData.error || "falha recuperada"}`,
          idempotencyKey: recData.idempotencyKey,
        });

        await doc.ref.update({
          status: "resolved",
          resolvedAt: new Date().toISOString(),
          refundOperationId: refundRes.operationId,
        });
        result.resolvedReconciliationsCount++;
      } catch (err: any) {
        console.error(`[RECONCILE] Falha ao processar reconciliação ${doc.id}:`, err);
        result.errors.push(`Reconciliação ${doc.id}: ${err.message}`);
        await doc.ref.update({
          attempts: Number(recData.attempts || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: String(err.message || err),
        });
      }
    }
  } catch (err: any) {
    console.warn("[RECONCILE] Erro ao buscar reconciliações pendentes:", err);
  }

  // 2. Processa operações interrompidas em status 'processing' no idempotency_keys
  try {
    const staleSnap = await firestore
      .collection("idempotency_keys")
      .where("status", "==", "processing")
      .limit(50)
      .get();

    for (const doc of staleSnap.docs) {
      const keyData = doc.data();
      const createdAt = keyData.createdAt || "";
      if (createdAt && createdAt < staleThresholdIso) {
        result.staleCount++;
        if (keyData.operationId && keyData.userId) {
          try {
            const userRef = firestore.collection("users").doc(keyData.userId);
            await executeCreditRefundTransactional(firestore, {
              userRef,
              amount: keyData.cost,
              originalOperationId: keyData.operationId,
              source: keyData.source || "chat",
              reason: "Estorno automático de consulta interrompida (timeout/stale)",
              idempotencyKey: keyData.idempotencyKey,
            });
            await doc.ref.update({
              status: "refunded",
              refundedAt: new Date().toISOString(),
              reason: "Estorno automático de consulta interrompida",
            });
            result.refundedCount++;
          } catch (refundErr: any) {
            console.error(`[RECONCILE] Falha no auto-estorno de operação stale ${doc.id}:`, refundErr);
            result.errors.push(`Stale op ${doc.id}: ${refundErr.message}`);
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("[RECONCILE] Erro ao buscar operações stale:", err);
  }

  return result;
}
