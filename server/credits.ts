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
  paymentId?: string;
  orderId?: string;
  adminId?: string;
  reason?: string;
  createdAt: string;
  committedAt?: string;
  reversedAt?: string;
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
    // Fail-open para rate-limit apenas se houver falha de rede transitória no Firestore,
    // preservando o rate limit in-memory já avaliado.
    console.warn("[RATE-LIMIT] Fallback de Firestore para in-memory:", err);
    return true;
  }
}

// ======================================================
// DÉBITO TRANSACIONAL COM IDEMPOTÊNCIA VERDADEIRA
// ======================================================
export interface DebitResult {
  isAlreadyCommitted: boolean;
  operationId: string;
  balanceBefore: number;
  balanceAfter: number;
  newXp: number;
  newLevel: string;
  xpAwarded: number;
}

export async function executeCreditDebitTransactional(
  firestore: any,
  params: {
    userRef: any;
    cost: number;
    xpAwarded: number;
    source: CreditLedgerRecord["source"];
    consultationId?: string;
    idempotencyKey?: string;
  }
): Promise<DebitResult> {
  const now = new Date().toISOString();
  const rawKey = params.idempotencyKey?.trim() || "";
  const sanitizedKey = rawKey ? rawKey.replace(/[^a-zA-Z0-9_\-]/g, "").substring(0, 128) : "";
  const keyDocId = sanitizedKey ? crypto.createHash("sha256").update(sanitizedKey).digest("hex") : "";
  const keyDocRef = keyDocId && firestore ? firestore.collection("idempotency_keys").doc(keyDocId) : null;

  return firestore.runTransaction(async (transaction: any) => {
    // 1. Se foi fornecida idempotencyKey, busca deterministicamente DENTRO da transação
    if (keyDocRef) {
      const keySnap = await transaction.get(keyDocRef);
      if (keySnap.exists) {
        const keyData = keySnap.data() || {};
        if (keyData.status === "committed") {
          return {
            isAlreadyCommitted: true,
            operationId: keyData.operationId,
            balanceBefore: keyData.balanceBefore,
            balanceAfter: keyData.balanceAfter,
            newXp: keyData.newXp ?? 0,
            newLevel: keyData.newLevel ?? "Buscador",
            xpAwarded: keyData.xpAwarded ?? 0,
          };
        }
        if (keyData.status === "processing") {
          const err: any = new Error("Uma operação idêntica já está em processamento. Aguarde.");
          err.status = 409;
          throw err;
        }
      }
    }

    // 2. Lê usuário atomicamente
    const userDoc = await transaction.get(params.userRef);
    if (!userDoc.exists) {
      const err: any = new Error("Usuário não encontrado.");
      err.status = 404;
      throw err;
    }

    const userData = userDoc.data() || {};
    const currentCredits = Number(userData.credits || 0);

    if (currentCredits < params.cost) {
      const err: any = new Error(
        `Saldo insuficiente (${currentCredits} Axé disponível, necessário ${params.cost}).`
      );
      err.status = 402;
      err.available = currentCredits;
      throw err;
    }

    const balanceAfter = currentCredits - params.cost;
    const currentXp = Number(userData.xp || 0);
    const newXp = currentXp + params.xpAwarded;
    const levelBefore = userData.level || "Buscador";
    const newLevel = getSpiritualLevelName(newXp);

    const operationId = "op_deb_" + crypto.randomUUID();

    // 3. Atualiza usuário atomicamente
    transaction.update(params.userRef, {
      credits: balanceAfter,
      xp: newXp,
      level: newLevel,
      updatedAt: now,
    });

    // 4. Grava ledger de auditoria imutável
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

    // 5. Grava documento de idempotência deterministicamente na mesma transação
    if (keyDocRef) {
      transaction.set(keyDocRef, {
        operationId,
        idempotencyKey: sanitizedKey,
        userId: userDoc.id,
        balanceBefore: currentCredits,
        balanceAfter,
        newXp,
        newLevel,
        xpAwarded: params.xpAwarded,
        status: "committed",
        createdAt: now,
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
    };
  });
}

// ======================================================
// ESTORNO TRANSACIONAL COMPLETO (REVERSÃO DE CRÉDITO, XP E NÍVEL)
// ======================================================
export interface RefundResult {
  operationId: string;
  balanceAfter: number;
  newXp: number;
  newLevel: string;
  alreadyRefunded: boolean;
}

export async function executeCreditRefundTransactional(
  firestore: any,
  params: {
    userRef: any;
    amount: number;
    originalOperationId: string;
    source: CreditLedgerRecord["source"];
    reason: string;
  }
): Promise<RefundResult> {
  const now = new Date().toISOString();
  const refundOpId = "op_ref_" + crypto.randomUUID();

  return firestore.runTransaction(async (transaction: any) => {
    // 1. Busca operação original no ledger para validar se já foi estornada
    const origDocRef = firestore.collection("credit_ledger").doc(params.originalOperationId);
    const origDoc = await transaction.get(origDocRef);

    let xpToRevert = 0;
    if (origDoc.exists) {
      const origData = origDoc.data() as CreditLedgerRecord;

      if (origData.status === "refunded" || origData.status === "reversed") {
        console.warn(`[REFUND] Operação ${params.originalOperationId} já foi estornada anteriormente.`);
        const userDoc = await transaction.get(params.userRef);
        const userData = userDoc.data() || {};
        return {
          operationId: params.originalOperationId,
          balanceAfter: Number(userData.credits || 0),
          newXp: Number(userData.xp || 0),
          newLevel: userData.level || "Buscador",
          alreadyRefunded: true,
        };
      }

      xpToRevert = Number(origData.xpAwarded || 0);

      // Marca a operação original como estornada
      transaction.update(origDocRef, {
        status: "refunded",
        reversedAt: now,
        refundOperationId: refundOpId,
      });
    }

    // 2. Lê usuário
    const userDoc = await transaction.get(params.userRef);
    if (!userDoc.exists) {
      throw new Error("Usuário não encontrado para efetuar estorno.");
    }

    const userData = userDoc.data() || {};
    const currentCredits = Number(userData.credits || 0);
    const currentXp = Number(userData.xp || 0);

    const balanceAfter = currentCredits + params.amount;
    const newXp = Math.max(0, currentXp - xpToRevert);
    const newLevel = getSpiritualLevelName(newXp);

    // 3. Atualiza usuário
    transaction.update(params.userRef, {
      credits: balanceAfter,
      xp: newXp,
      level: newLevel,
      updatedAt: now,
    });

    // 4. Cria registro de refund
    const refundRef = firestore.collection("credit_ledger").doc(refundOpId);
    transaction.set(refundRef, {
      operationId: refundOpId,
      originalOperationId: params.originalOperationId,
      userId: userDoc.id,
      firebaseUid: userData.firebaseUid || "",
      type: "refund",
      amount: params.amount,
      balanceBefore: currentCredits,
      balanceAfter,
      xpBefore: currentXp,
      xpAfter: newXp,
      levelBefore: userData.level || "Buscador",
      levelAfter: newLevel,
      status: "refunded",
      source: params.source,
      reason: params.reason,
      createdAt: now,
      committedAt: now,
    });

    return {
      operationId: refundOpId,
      balanceAfter,
      newXp,
      newLevel,
      alreadyRefunded: false,
    };
  });
}
