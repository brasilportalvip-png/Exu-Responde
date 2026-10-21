import crypto from "node:crypto";

function creditError(message: string, code = "CREDIT_STATE_INVALID", status = 409): never {
  const error: any = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function safeCreditNumber(value: any, label: string, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    creditError(`Valor inválido em ${label}. Operação não executada.`);
  }
  return value;
}

function assertConsultationLink(key: any, debit: any, userId: string, operationId: string, source: string): void {
  if (key.userId !== userId || debit.userId !== userId) {
    creditError("Operação pertence a outro usuário ou não possui proprietário válido.", "USER_MISMATCH", 403);
  }
  if (!operationId || key.operationId !== operationId || debit.operationId !== operationId ||
      debit.type !== "debit" || key.source !== source || debit.source !== source ||
      !key.idempotencyKey || key.idempotencyKey !== debit.idempotencyKey ||
      key.cost !== debit.amount || key.xpAwarded !== debit.xpAwarded) {
    creditError("O débito e a consulta não correspondem. Recuperação requer conferência.");
  }
  safeCreditNumber(debit.amount, "débito", true);
  safeCreditNumber(debit.xpAwarded, "XP do débito");
}


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
  status: "processing" | "committed" | "completed" | "reversed" | "refunded" | "failed";
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
  completedAt?: string;
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
  adminRefunded?: boolean;
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
// VALIDAÇÃO E UTILITÁRIOS UNIFICADOS DE IDEMPOTÊNCIA
// ======================================================
export function validateIdempotencyKey(key?: unknown): { valid: boolean; error?: string; cleanKey?: string } {
  if (!key || typeof key !== "string") {
    return { valid: false, error: "Chave de idempotência ausente ou inválida." };
  }
  const clean = key.trim();
  if (clean.length < 8) {
    return { valid: false, error: "Chave de idempotência muito curta (mínimo 8 caracteres)." };
  }
  if (clean.length > 128) {
    return { valid: false, error: "Chave de idempotência excede o tamanho máximo (128 caracteres)." };
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(clean)) {
    return { valid: false, error: "Chave de idempotência deve conter apenas caracteres alfanuméricos, hífen ou sublinhado." };
  }
  return { valid: true, cleanKey: clean };
}

export function buildScopedIdempotencyDocId(
  userId: string,
  source: string,
  idempotencyKey: string
): string {
  const cleanUser = String(userId || "").trim();
  const cleanSource = String(source || "").trim();
  const cleanKey = String(idempotencyKey || "").trim();

  if (!cleanUser || !cleanSource || !cleanKey) {
    throw new Error("Parâmetros insuficientes para geração do escopo de idempotência.");
  }

  // Representação canônica inequívoca do escopo completo (sem truncamentos com risco de colisão)
  const canonicalScope = `u:${cleanUser}|s:${cleanSource}|k:${cleanKey}`;
  const scopeHash = crypto.createHash("sha256").update(canonicalScope).digest("hex");
  return `idem_${scopeHash}`;
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
  idempotencyKey: string;
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
  const keyValidation = validateIdempotencyKey(params.idempotencyKey);
  if (!keyValidation.valid || !keyValidation.cleanKey) {
    const err: any = new Error(keyValidation.error || "Chave de idempotência inválida.");
    err.status = 400;
    err.code = "INVALID_IDEMPOTENCY_KEY";
    throw err;
  }
  const sanitizedKey = keyValidation.cleanKey;

  // Validação estrita de valores numéricos inteiros finitos
  if (!Number.isSafeInteger(params.cost) || params.cost <= 0) {
    const err: any = new Error(`Valor de custo inválido (${params.cost}). Deve ser um número inteiro positivo.`);
    err.status = 400;
    throw err;
  }
  if (!Number.isSafeInteger(params.xpAwarded) || params.xpAwarded < 0) {
    const err: any = new Error(`Valor de XP inválido (${params.xpAwarded}). Deve ser um número inteiro não negativo.`);
    err.status = 400;
    throw err;
  }

  const targetUserId = params.userRef?.id || "";
  if (!targetUserId) {
    const err: any = new Error("Referência de usuário inválida para débito.");
    err.status = 400;
    throw err;
  }

  const scopedKeyDocId = buildScopedIdempotencyDocId(targetUserId, params.source, sanitizedKey);
  const keyDocRef = firestore.collection("idempotency_keys").doc(scopedKeyDocId);
  const now = new Date().toISOString();

  return firestore.runTransaction(async (transaction: any) => {
    // ==========================================
    // FASE 1: TODAS AS LEITURAS PRIMEIRO (STRICT READS)
    // ==========================================
    const keySnap = await transaction.get(keyDocRef);
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
    if (userData.isBlocked) {
      const err: any = new Error("Este perfil foi suspenso por medidas de segurança do terreiro.");
      err.status = 403;
      err.code = "ACCOUNT_BLOCKED";
      throw err;
    }

    const currentCredits = safeCreditNumber(userData.credits ?? 0, "saldo");
    const currentXp = safeCreditNumber(userData.xp ?? 0, "XP");

    if (keySnap && keySnap.exists) {
      const keyData = keySnap.data() || {};

      // 1. Validação de isolamento de usuário: chave não pode ser reutilizada por outro usuário
      if (keyData.userId !== userDoc.id) {
        const err: any = new Error("Chave de idempotência vinculada a outro usuário.");
        err.status = 409;
        throw err;
      }

      // 2. Validação de modalidade: mesma chave com modalidade diferente gera conflito
      if (keyData.source !== params.source) {
        const err: any = new Error(
          `Chave de idempotência reutilizada para modalidade diferente (${keyData.source} vs ${params.source}).`
        );
        err.status = 409;
        throw err;
      }

      // 3. Validação de integridade do conteúdo da requisição
      if ((keyData.requestHash || "") !== (params.requestHash || "")) {
        const err: any = new Error(
          "Chave de idempotência reutilizada com pergunta ou parâmetros diferentes da consulta original."
        );
        err.status = 409;
        throw err;
      }

      if (typeof keyData.operationId !== "string" || !keyData.operationId || keyData.operationId.includes("/")) {
        creditError("Identificador do débito ausente ou inválido.");
      }
      const debitSnap = await transaction.get(firestore.collection("credit_ledger").doc(keyData.operationId));
      if (!debitSnap.exists) creditError("Débito original não encontrado.");
      const debitData = debitSnap.data() || {};
      assertConsultationLink(keyData, debitData, userDoc.id, keyData.operationId, params.source);
      if (keyData.status === "completed" && (debitData.status !== "completed" || keyData.persistedResponse == null)) {
        creditError("Resposta concluída inconsistente. Aguarde recuperação.");
      }
      if (keyData.status === "refunded" && !["refunded", "reversed"].includes(debitData.status)) {
        creditError("Estorno ainda não confirmado no débito original.");
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

      // 5. Se a consulta já foi estornada (ou falhou definitivamente):
      // Bloqueia reutilização da chave estornada para proteger contra interferência de processos atrasados
      if (keyData.status === "refunded") {
        const err: any = new Error(
          "Esta chave de idempotência refere-se a uma consulta que já foi estornada. Gere uma nova consulta com uma nova chave."
        );
        err.status = 409;
        err.code = "KEY_ALREADY_REFUNDED";
        throw err;
      }

      // 6. Se está em processamento concorrente:
      if (keyData.status === "processing") {
        const createdAtMs = new Date(keyData.createdAt || 0).getTime();
        // Tempo compatível com o ciclo real da consulta (90 segundos de timeout)
        const isStale = Date.now() - createdAtMs >= 90_000;
        if (!isStale) {
          const err: any = new Error(
            "Uma consulta idêntica já está em processamento no terreiro. Aguarde a conclusão."
          );
          err.status = 409;
          err.code = "OPERATION_IN_PROGRESS";
          throw err;
        }
        // Se a operação ficou presa (>= 90s), sinaliza para recuperação
        const err: any = new Error(
          "Operação anterior foi interrompida antes da conclusão. Aguarde o estorno automático ou tente com nova consulta."
        );
        err.status = 409;
        err.code = "STALE_OPERATION_PENDING_RECOVERY";
        throw err;
      }
      creditError("Estado da consulta exige recuperação; a chave não pode gerar novo débito.");
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
    const newXp = safeCreditNumber(currentXp + params.xpAwarded, "novo XP");
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
      idempotencyKey: sanitizedKey,
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
// PERSISTÊNCIA OBRIGATÓRIA DA RESPOSTA COMPLETA DA CONSULTA
// ======================================================
export async function completeConsultationTransactional(
  firestore: any,
  params: {
    userId: string;
    source: CreditLedgerRecord["source"];
    idempotencyKey: string;
    operationId: string;
    responsePayload: any;
  }
): Promise<void> {
  const keyValidation = validateIdempotencyKey(params.idempotencyKey);
  if (!keyValidation.valid || !keyValidation.cleanKey) {
    const err: any = new Error("Chave de idempotência inválida para conclusão da consulta.");
    err.status = 400;
    throw err;
  }
  const cleanKey = keyValidation.cleanKey;

  if (!params.operationId || typeof params.operationId !== "string") {
    const err: any = new Error("Identificador da operação original é obrigatório para conclusão.");
    err.status = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const scopedId = buildScopedIdempotencyDocId(params.userId, params.source, cleanKey);
  const keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);
  const ledgerDocRef = firestore.collection("credit_ledger").doc(params.operationId);

  await firestore.runTransaction(async (transaction: any) => {
    // 1. Leituras estritas
    const [keySnap, ledgerSnap] = await Promise.all([
      transaction.get(keyDocRef),
      transaction.get(ledgerDocRef),
    ]);

    if (!keySnap.exists) {
      const err: any = new Error(
        `Registro de idempotência '${scopedId}' não encontrado para conclusão da consulta.`
      );
      err.status = 404;
      err.code = "OPERATION_NOT_FOUND";
      throw err;
    }

    const keyData = keySnap.data() || {};

    // Valida correspondência de usuário
    if (keyData.userId !== params.userId) {
      const err: any = new Error("Chave de idempotência vinculada a outro usuário.");
      err.status = 403;
      err.code = "USER_MISMATCH";
      throw err;
    }

    // Valida correspondência exata de operationId para impedir que processos atrasados interfiram
    if (keyData.operationId !== params.operationId) {
      const err: any = new Error(
        `Operação divergente: a chave está vinculada à operação ${keyData.operationId}, mas a conclusão solicitou ${params.operationId}.`
      );
      err.status = 409;
      err.code = "OPERATION_ID_MISMATCH";
      throw err;
    }

    if (!ledgerSnap.exists) creditError("Débito original não encontrado para conclusão.");
    const ledgerData = ledgerSnap.data() || {};
    assertConsultationLink(keyData, ledgerData, params.userId, params.operationId, params.source);
    if (["refunded", "reversed"].includes(ledgerData.status)) {
      creditError("O débito já foi estornado.", "OPERATION_ALREADY_REFUNDED");
    }
    if (params.responsePayload == null || typeof params.responsePayload !== "object" ||
        Array.isArray(params.responsePayload) || Object.keys(params.responsePayload).length === 0) {
      creditError("Resposta completa obrigatória para concluir a consulta.");
    }
    if (keyData.status === "completed" && (ledgerData.status !== "completed" || keyData.persistedResponse == null)) {
      creditError("Conclusão inconsistente no registro original.");
    }
    if (keyData.status !== "completed" && (keyData.status !== "processing" || ledgerData.status !== "committed")) {
      creditError("Estado da operação não permite conclusão.");
    }
    // Se a consulta foi estornada por processo de timeout/reconciliação, rejeita com erro explícito
    if (keyData.status === "refunded") {
      const err: any = new Error(
        `A consulta vinculada à operação ${params.operationId} já foi estornada e não pode ser concluída.`
      );
      err.status = 409;
      err.code = "OPERATION_ALREADY_REFUNDED";
      throw err;
    }

    // Se já foi concluída com a mesma operação, nada mais a alterar
    if (keyData.status === "completed") {
      return;
    }

    // 2. Escritas atômicas
    transaction.update(keyDocRef, {
      status: "completed",
      persistedResponse: params.responsePayload,
      completedAt: now,
      updatedAt: now,
    });

    if (ledgerSnap.exists) {
      transaction.update(ledgerDocRef, {
        status: "completed",
        completedAt: now,
      });
    }
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
    isAdministrative?: boolean;
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
      const keyValidation = validateIdempotencyKey(effectiveIdempotencyKey);
      if (keyValidation.valid && keyValidation.cleanKey) {
        const scopedId = buildScopedIdempotencyDocId(
          userDoc.id,
          origData.source || params.source,
          keyValidation.cleanKey
        );
        keyDocRef = firestore.collection("idempotency_keys").doc(scopedId);
        keySnap = await transaction.get(keyDocRef);
      }
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
    if (origData.userId !== userDoc.id) {
      const err: any = new Error(
        "Operação original pertence a outro consulente. Estorno não autorizado."
      );
      err.status = 403;
      throw err;
    }

    if (origData.operationId !== params.originalOperationId || origData.source !== params.source) {
      creditError("Operação ou modalidade divergente no estorno.");
    }
    if (params.idempotencyKey && params.idempotencyKey !== origData.idempotencyKey) {
      creditError("Chave divergente no estorno.");
    }
    if (!keySnap?.exists) creditError("Registro da consulta ausente; estorno exige reconciliação.");
    const refundKeyData = keySnap.data() || {};
    assertConsultationLink(refundKeyData, origData, userDoc.id, params.originalOperationId, params.source);

    // Validação 3: Derivar valor do estorno do débito original e rejeitar divergências
    const originalDebitAmount = Number(origData.amount || 0);
    if (!Number.isSafeInteger(originalDebitAmount) || originalDebitAmount <= 0) {
      const err: any = new Error("Valor do débito original é inválido.");
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

    // Confirma o lançamento de devolução antes de informar estorno já realizado.
    if (origData.status === "refunded" || origData.status === "reversed") {
      if (!origData.refundOperationId) creditError("Comprovante do estorno ausente.");
      const refundProof = await transaction.get(firestore.collection("credit_ledger").doc(origData.refundOperationId));
      const proof = refundProof.exists ? refundProof.data() : null;
      if (!proof || proof.type !== "refund" || proof.userId !== userDoc.id ||
          proof.originalOperationId !== params.originalOperationId || proof.amount !== originalDebitAmount) {
        creditError("Lançamento de estorno inconsistente; devolução não confirmada.");
      }
    }

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

    // Consulta concluída não é um estorno bem-sucedido.
    if ((origData.status === "completed" || refundKeyData.status === "completed") && !params.isAdministrative) {
      creditError("Consulta já concluída; nenhum crédito foi estornado.", "OPERATION_ALREADY_COMPLETED");
    }
    if (!["committed", "completed"].includes(origData.status) ||
        !["processing", "completed"].includes(refundKeyData.status)) {
      creditError("Estado incompatível com estorno.");
    }

    const xpToRevert = safeCreditNumber(origData.xpAwarded, "XP do débito");
    const currentCredits = safeCreditNumber(userData.credits ?? 0, "saldo");
    const currentXp = safeCreditNumber(userData.xp ?? 0, "XP");

    const balanceAfter = safeCreditNumber(currentCredits + originalDebitAmount, "saldo após estorno");
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
      xpAwarded: newXp - currentXp,
      levelBefore: userData.level || "Buscador",
      levelAfter: newLevel,
      status: "refunded",
      source: params.source || origData.source,
      reason: params.reason,
      createdAt: now,
      committedAt: now,
      isAdministrative: Boolean(params.isAdministrative),
    });

    // 4. Atualiza registro de idempotência para status 'refunded'
    if (keyDocRef && keySnap && keySnap.exists) {
      transaction.update(keyDocRef, {
        status: "refunded",
        refundOperationId: refundOpId,
        refundedAt: now,
        updatedAt: now,
        adminRefunded: Boolean(params.isAdministrative),
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
// RECUPERAÇÃO ATÔMICA DE OPERAÇÃO STALE (PROTEÇÃO CONTRA CORRIDA)
// ======================================================
export async function recoverStaleOperationTransactional(
  firestore: any,
  params: {
    keyDocId: string;
    expectedOperationId: string;
    expectedUserId: string;
    staleTimeoutMs?: number;
    reason?: string;
  }
): Promise<{
  resolved: boolean;
  reason: string;
  refundOperationId?: string;
  refundedAmount?: number;
}> {
  // O tempo mínimo real para abandono deve ser de ao menos 60 segundos (padrão 90s)
  const timeoutMs = Math.max(90_000, safeCreditNumber(params.staleTimeoutMs ?? 90_000, "prazo de recuperação", true));
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const keyDocRef = firestore.collection("idempotency_keys").doc(params.keyDocId);
  const ledgerDocRef = firestore.collection("credit_ledger").doc(params.expectedOperationId);
  const userDocRef = firestore.collection("users").doc(params.expectedUserId);

  return firestore.runTransaction(async (transaction: any) => {
    // 1. Leituras estritas
    const [keySnap, origSnap, userSnap] = await Promise.all([
      transaction.get(keyDocRef),
      transaction.get(ledgerDocRef),
      transaction.get(userDocRef),
    ]);

    if (!keySnap.exists) {
      return { resolved: false, reason: "key_not_found" };
    }

    const keyData = keySnap.data() || {};

    if (!origSnap.exists || !userSnap.exists) creditError("Débito ou usuário ausente para recuperação.");
    assertConsultationLink(keyData, origSnap.data() || {}, params.expectedUserId, params.expectedOperationId, keyData.source);

    // PONTO CRÍTICO DE CORRIDA: Se a consulta foi concluída no intervalo de seleção, ABORTA o estorno!
    if (keyData.status === "completed") {
      return { resolved: false, reason: "already_completed" };
    }

    // Se já foi estornada anteriormente, aborta sem debitar/estornar novamente
    if (keyData.status === "refunded") {
      return { resolved: false, reason: "already_refunded" };
    }

    // Se o operationId divergir (outra execução assumiu a chave), aborta
    if (keyData.operationId && keyData.operationId !== params.expectedOperationId) {
      return { resolved: false, reason: "operation_mismatch" };
    }

    // Valida se o registro ainda está stale no momento da transação
    const createdAtMs = new Date(keyData.createdAt).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) creditError("Data da consulta inválida.");
    if (keyData.status !== "processing") creditError("Estado inválido para recuperação automática.");
    if (nowMs - createdAtMs < timeoutMs) {
      return { resolved: false, reason: "not_stale" };
    }

    if (!origSnap.exists || !userSnap.exists) {
      return { resolved: false, reason: "missing_ledger_or_user" };
    }

    const origData = origSnap.data() || {};
    if (origData.status === "refunded" || origData.status === "reversed") {
      transaction.update(keyDocRef, {
        status: "refunded",
        updatedAt: now,
      });
      return { resolved: false, reason: "ledger_already_refunded" };
    }

    if (origData.status === "completed") return { resolved: false, reason: "already_completed" };
    if (origData.status !== "committed") creditError("Débito não permite recuperação automática.");
    const refundAmount = safeCreditNumber(origData.amount, "débito", true);
    const xpToRevert = safeCreditNumber(origData.xpAwarded, "XP do débito");
    const userData = userSnap.data() || {};
    const currentCredits = safeCreditNumber(userData.credits ?? 0, "saldo");
    const currentXp = safeCreditNumber(userData.xp ?? 0, "XP");

    const balanceAfter = safeCreditNumber(currentCredits + refundAmount, "saldo após recuperação");
    const newXp = Math.max(0, currentXp - xpToRevert);
    const newLevel = getSpiritualLevelName(newXp);
    const refundOpId = "op_ref_" + crypto.randomUUID();

    // 2. Escritas atômicas dentro da transação — nenhuma escrita avulsa externa
    transaction.update(userDocRef, {
      credits: balanceAfter,
      xp: newXp,
      level: newLevel,
      updatedAt: now,
    });

    transaction.update(ledgerDocRef, {
      status: "refunded",
      reversedAt: now,
      refundOperationId: refundOpId,
    });

    const refundRef = firestore.collection("credit_ledger").doc(refundOpId);
    transaction.set(refundRef, {
      operationId: refundOpId,
      originalOperationId: params.expectedOperationId,
      userId: userSnap.id,
      firebaseUid: userData.firebaseUid || "",
      type: "refund",
      amount: refundAmount,
      balanceBefore: currentCredits,
      balanceAfter,
      xpBefore: currentXp,
      xpAfter: newXp,
      xpAwarded: newXp - currentXp,
      levelBefore: userData.level || "Buscador",
      levelAfter: newLevel,
      status: "refunded",
      source: keyData.source || origData.source || "chat",
      reason: params.reason || "Reconciliação atômica de consulta stale/interrompida",
      createdAt: now,
      committedAt: now,
    });

    transaction.update(keyDocRef, {
      status: "refunded",
      refundOperationId: refundOpId,
      refundedAt: now,
      updatedAt: now,
      staleRecovered: true,
    });

    return {
      resolved: true,
      reason: "refunded_successfully",
      refundOperationId: refundOpId,
      refundedAmount: refundAmount,
    };
  });
}

// ======================================================
// ESTRATÉGIA DE RECUPERAÇÃO E RECONCILIAÇÃO COM PAGINAÇÃO
// ======================================================
export interface ReconcileOptions {
  limit?: number;
  staleTimeoutMs?: number;
  startAfterDocId?: string;
}

export interface ReconcileResult {
  success: boolean;
  staleCount: number;
  refundedCount: number;
  skippedCompletedCount: number;
  resolvedReconciliationsCount: number;
  errors: string[];
  hasMore: boolean;
  lastProcessedDocId?: string;
}

export async function reconcilePendingOperations(
  firestore: any,
  options?: ReconcileOptions
): Promise<ReconcileResult> {
  const batchLimit = Math.min(safeCreditNumber(options?.limit ?? 25, "limite", true), 100);
  const staleTimeoutMs = Math.max(90_000, safeCreditNumber(options?.staleTimeoutMs ?? 90_000, "prazo de recuperação", true));

  const result: ReconcileResult = {
    success: true,
    staleCount: 0,
    refundedCount: 0,
    skippedCompletedCount: 0,
    resolvedReconciliationsCount: 0,
    errors: [],
    hasMore: false,
  };

  if (!firestore) {
    result.success = false;
    result.errors.push("Instância do Firestore indisponível para reconciliação.");
    return result;
  }

  const nowMs = Date.now();
  const staleThresholdIso = new Date(nowMs - staleTimeoutMs).toISOString();

  // 1. Processa fila de reconciliações pendentes
  try {
    const recSnap = await firestore
      .collection("reconciliations")
      .where("status", "==", "reconciliation_required")
      .limit(batchLimit)
      .get();

    for (const doc of recSnap.docs) {
      const recData = doc.data() || {};
      if (!recData.userId || !recData.operationId) {
        // Registro inválido: marca para não bloquear a fila
        await doc.ref.update({
          status: "invalid_unrecoverable",
          updatedAt: new Date().toISOString(),
          error: "Campos obrigatórios ausentes (userId ou operationId)",
        });
        result.errors.push(`Reconciliação ${doc.id} marcada como inválida: dados incompletos.`);
        continue;
      }

      try {
        const userRef = firestore.collection("users").doc(recData.userId);
        const refundRes = await executeCreditRefundTransactional(firestore, {
          userRef,
          amount: recData.amount || recData.creditsCost,
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
        if (err.code === "OPERATION_ALREADY_COMPLETED") {
          await doc.ref.update({ status: "resolved", resolution: "already_completed", resolvedAt: new Date().toISOString() });
          result.skippedCompletedCount++;
          result.resolvedReconciliationsCount++;
          continue;
        }
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
    console.error("[RECONCILE] Falha de banco na fila de reconciliação:", err);
    result.success = false;
    result.errors.push(`Consulta a reconciliations falhou: ${err.message}`);
  }

  // 2. Processa operações interrompidas com ordenação estável e paginação
  try {
    let staleQuery = firestore
      .collection("idempotency_keys")
      .where("status", "==", "processing")
      .orderBy("createdAt", "asc")
      .limit(batchLimit);

    if (options?.startAfterDocId) {
      const cursorSnap = await firestore
        .collection("idempotency_keys")
        .doc(options.startAfterDocId)
        .get();
      if (cursorSnap.exists && typeof staleQuery.startAfter === "function") {
        staleQuery = staleQuery.startAfter(cursorSnap);
      }
    }

    const staleSnap = await staleQuery.get();
    if (staleSnap.docs.length >= batchLimit) {
      result.hasMore = true;
    }

    for (const doc of staleSnap.docs) {
      result.lastProcessedDocId = doc.id;
      const keyData = doc.data() || {};
      const createdAt = keyData.createdAt || "";

      // Trata registros inválidos para não bloquear a esteira
      if (!keyData.operationId || !keyData.userId) {
        result.errors.push(`Chave ${doc.id}: identificação incompleta; recuperação manual necessária.`);
        continue;
      }

      if (createdAt && createdAt < staleThresholdIso) {
        result.staleCount++;
        try {
          const recovery = await recoverStaleOperationTransactional(firestore, {
            keyDocId: doc.id,
            expectedOperationId: keyData.operationId,
            expectedUserId: keyData.userId,
            staleTimeoutMs,
            reason: "Estorno atômico de consulta stale/interrompida",
          });

          if (recovery.resolved) {
            result.refundedCount++;
          } else if (recovery.reason === "already_completed") {
            result.skippedCompletedCount++;
          }
        } catch (refundErr: any) {
          console.error(`[RECONCILE] Falha no auto-estorno atômico ${doc.id}:`, refundErr);
          result.errors.push(`Stale op ${doc.id}: ${refundErr.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error("[RECONCILE] Falha de banco nas operações stale:", err);
    result.success = false;
    result.errors.push(`Consulta a idempotency_keys falhou: ${err.message}`);
  }

  result.success = result.success && result.errors.length === 0;
  return result;
}
