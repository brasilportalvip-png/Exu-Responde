/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import express from "express";
import path from "path";
import fs from "fs";
import crypto, { randomInt } from "node:crypto";
// import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type Auth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import {
  registerBodySchema,
  userUpdateSchema,
  chatBodySchema,
  tarotBodySchema,
  buziosBodySchema,
  numerologiaBodySchema,
  astrologiaBodySchema,
  adminCreditAdjustSchema,
  idempotencyKeySchema,
  parseBirthDateStrict,
  isValidIanaTimeZone,
} from "../server/validation.ts";
import { toPublicUserDTO, type PublicUserDTO } from "../server/dto.ts";
import { getUserDateTimeContext } from "../server/time.ts";
import { classifyQuestionIntent, type IntentCategory } from "../server/intent.ts";
import {
  executeGeminiWithFallback,
  GEMINI_MODELS,
  type GeminiTelemetryResult,
} from "../server/gemini.ts";
import {
  checkAtomicDurableRateLimit,
  executeCreditDebitTransactional as executeCreditDebitTransactionalCore,
  executeCreditRefundTransactional as executeCreditRefundTransactionalCore,
  calculateSpiritualLevel,
  type CreditLedgerRecord,
} from "../server/credits.ts";
import {
  getClientIp,
  createAppCheckMiddleware,
  recordSecurityAudit,
} from "../server/security.ts";
import {
  CREDIT_PLANS,
  getPlanById,
  verifyMercadoPagoSignature,
} from "../server/mercadopago.ts";
import {
  drawTarotCardsReal,
  castBuziosReal,
  TAROT_DECK,
  ODUS_BUZIOS,
} from "../server/oracles.ts";
import { queueAndSendPurchaseEmails } from "../server/email.ts";

dotenv.config({ path: ".env.local" });
dotenv.config();

const FIREBASE_ENV_KEYS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
] as const;

function checkIsProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.VERCEL && process.env.VERCEL_ENV === "production")
  );
}

let firestore: Firestore;
let firebaseAuth: Auth;
let firebaseInitializationError: Error | null = null;

function getMissingFirebaseEnvironmentVariables(): string[] {
  return FIREBASE_ENV_KEYS.filter((key) => !process.env[key]?.trim());
}

const mockCollections = new Map<string, Map<string, Record<string, any>>>();

function createMockFirestore(): Firestore {
  const getColMap = (colName: string) => {
    let col = mockCollections.get(colName);
    if (!col) {
      col = new Map<string, Record<string, any>>();
      mockCollections.set(colName, col);
    }
    return col;
  };

  const makeDocRef = (colName: string, docId: string): any => {
    const col = getColMap(colName);
    return {
      id: docId,
      async get() {
        const data = col.get(docId);
        return {
          id: docId,
          exists: data !== undefined,
          data: () => (data ? { ...data } : undefined),
          ref: makeDocRef(colName, docId),
        };
      },
      async set(data: Record<string, any>, options?: { merge?: boolean }) {
        const existing = col.get(docId) || {};
        col.set(docId, options?.merge ? { ...existing, ...data } : { ...data });
      },
      async update(data: Record<string, any>) {
        const existing = col.get(docId) || {};
        col.set(docId, { ...existing, ...data });
      },
    };
  };

  const buildQuery = (
    colName: string,
    filters: Array<{ field: string; op: string; val: any }> = [],
    orderField?: string,
    orderDir: "asc" | "desc" = "asc",
    limitCount?: number
  ): any => {
    return {
      where(field: string, op: string, val: any) {
        return buildQuery(
          colName,
          [...filters, { field, op, val }],
          orderField,
          orderDir,
          limitCount
        );
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        return buildQuery(colName, filters, field, dir, limitCount);
      },
      limit(n: number) {
        return buildQuery(colName, filters, orderField, orderDir, n);
      },
      async get() {
        const col = getColMap(colName);
        let entries = Array.from(col.entries());
        for (const f of filters) {
          if (f.op === "==") {
            entries = entries.filter(([, docData]) => docData?.[f.field] === f.val);
          }
        }
        if (orderField) {
          entries.sort(([, a], [, b]) => {
            const va = a?.[orderField] ?? "";
            const vb = b?.[orderField] ?? "";
            if (va < vb) return orderDir === "desc" ? 1 : -1;
            if (va > vb) return orderDir === "desc" ? -1 : 1;
            return 0;
          });
        }
        if (typeof limitCount === "number") {
          entries = entries.slice(0, limitCount);
        }
        const docs = entries.map(([id, data]) => ({
          id,
          exists: true,
          data: () => ({ ...data }),
          ref: makeDocRef(colName, id),
        }));
        return {
          empty: docs.length === 0,
          docs,
        };
      },
    };
  };

  return {
    collection(colName: string) {
      const baseQuery = buildQuery(colName);
      return {
        ...baseQuery,
        doc(docId?: string) {
          const id = docId || "doc_" + Math.random().toString(36).substring(2, 11);
          return makeDocRef(colName, id);
        },
        async add(data: Record<string, any>) {
          const id = "doc_" + Math.random().toString(36).substring(2, 11);
          const ref = makeDocRef(colName, id);
          await ref.set(data);
          return ref;
        },
      };
    },
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        set(ref: any, data: Record<string, any>, options?: { merge?: boolean }) {
          ops.push(() => ref.set(data, options));
        },
        update(ref: any, data: Record<string, any>) {
          ops.push(() => ref.update(data));
        },
        async commit() {
          for (const op of ops) {
            await op();
          }
        },
      };
    },
    async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, data: Record<string, any>, options?: { merge?: boolean }) {
          ref.set(data, options);
        },
        update(ref: any, data: Record<string, any>) {
          ref.update(data);
        },
      };
      return updateFunction(tx);
    },
  } as unknown as Firestore;
}

function createMockFirebaseAuth(): Auth {
  return {
    async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
      if (checkIsProduction()) {
        throw new Error("Tokens simulados são estritamente proibidos em ambiente de produção.");
      }
      try {
        const decodedStr = Buffer.from(idToken, "base64").toString("utf-8");
        const parsed = JSON.parse(decodedStr);
        if (parsed && typeof parsed.uid === "string" && parsed.uid.trim()) {
          return {
            uid: parsed.uid.trim(),
            email: typeof parsed.email === "string" ? parsed.email : "",
            email_verified: parsed.email_verified !== false,
          } as DecodedIdToken;
        }
      } catch {
        // Token inválido
      }
      throw new Error("Token de autenticação inválido.");
    },
  } as unknown as Auth;
}

function initializeFirebaseAdmin(): void {
  if (firestore && firebaseAuth) {
    return;
  }

  const missingVariables = getMissingFirebaseEnvironmentVariables();

  if (missingVariables.length > 0) {
    if (checkIsProduction()) {
      const err = new Error(
        `[SEGURANÇA] Firebase Admin não configurado em ambiente de produção (${missingVariables.join(
          ", "
        )}). Fallback mock é estritamente proibido.`
      );
      firebaseInitializationError = err;
      throw err;
    }

    console.warn(
      `[AI Studio DEV] Firebase Admin env vars missing (${missingVariables.join(", ")}) — using in-memory Firestore & Auth mock (apenas ambiente de desenvolvimento/teste).`
    );
    firestore = createMockFirestore();
    firebaseAuth = createMockFirebaseAuth();
    firebaseInitializationError = null;
    return;
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY!
    .replace(/\\n/g, "\n")
    .trim();

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    if (checkIsProduction()) {
      const err = new Error(
        "FIREBASE_PRIVATE_KEY possui formato inválido. Informe a chave privada completa da conta de serviço."
      );
      firebaseInitializationError = err;
      throw err;
    }
    console.warn(
      "[AI Studio DEV] FIREBASE_PRIVATE_KEY é um placeholder de teste — usando in-memory Firestore & Auth mock."
    );
    firestore = createMockFirestore();
    firebaseAuth = createMockFirebaseAuth();
    firebaseInitializationError = null;
    return;
  }

  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID!.trim(),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!.trim(),
          privateKey
        })
      });
    }

    firestore = getFirestore();
    firebaseAuth = getAuth();
    firebaseInitializationError = null;
  } catch (error) {
    if (checkIsProduction()) {
      firebaseInitializationError =
        error instanceof Error ? error : new Error(String(error));
      throw firebaseInitializationError;
    }
    console.warn(
      "[AI Studio DEV] Falha ao certificar chave privada com Firebase Admin (placeholder) — usando in-memory Firestore & Auth mock."
    );
    firestore = createMockFirestore();
    firebaseAuth = createMockFirebaseAuth();
    firebaseInitializationError = null;
    return;
  }
}

const mp = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || ""
});

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "256kb" }));
app.use(
  createAppCheckMiddleware(() => {
    try {
      initializeFirebaseAdmin();
    } catch {
      // Ignore
    }
    return getApps().length ? getApps()[0] : null;
  })
);

app.get("/api/health", (_req, res) => {
  const isProd = checkIsProduction();
  const missingVariables = getMissingFirebaseEnvironmentVariables();
  let isFbReady = false;
  let fbError: string | null = null;

  try {
    initializeFirebaseAdmin();
    isFbReady = Boolean(firestore && firebaseAuth);
  } catch (err: any) {
    isFbReady = false;
    fbError = err.message || "Erro na inicialização do Firebase";
  }

  const isGeminiReady = Boolean(process.env.GEMINI_API_KEY?.trim());
  const isMercadoPagoReady = Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim());
  const isEmailReady = Boolean(
    process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim()
  );

  if (isProd && (!isFbReady || missingVariables.length > 0)) {
    return res.status(503).json({
      status: "degraded",
      code: "FIREBASE_ADMIN_NOT_CONFIGURED",
      environment: "production",
      services: {
        api: "ready",
        firebaseAdmin: "unconfigured",
        gemini: isGeminiReady ? "configured" : "unconfigured",
        mercadoPago: isMercadoPagoReady ? "configured" : "unconfigured",
        email: isEmailReady ? "configured" : "unconfigured",
      },
      missingVariables,
      error: fbError,
    });
  }

  return res.status(200).json({
    status: isFbReady ? "ok" : isProd ? "degraded" : "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    environment: isProd ? "production" : (process.env.NODE_ENV || "development"),
    services: {
      api: "ready",
      firebaseAdmin: isFbReady
        ? (missingVariables.length === 0 ? "ready" : "mock_development_only")
        : isProd
        ? "unconfigured"
        : "mock_development_only",
      gemini: isGeminiReady ? "configured" : "unconfigured",
      mercadoPago: isMercadoPagoReady ? "configured" : "unconfigured",
      email: isEmailReady ? "configured" : "unconfigured",
    },
  });
});

app.use("/api", (_req, res, next) => {
  try {
    initializeFirebaseAdmin();
    return next();
  } catch (error) {
    const initializationError =
      error instanceof Error ? error : new Error(String(error));

    if (firebaseInitializationError?.message !== initializationError.message) {
      firebaseInitializationError = initializationError;
      console.error("[FIREBASE] Falha de inicialização:", initializationError.message);
    }

    return res.status(503).json({
      code: "FIREBASE_ADMIN_NOT_CONFIGURED",
      error:
        "O servidor de autenticação está temporariamente indisponível. Tente novamente em alguns instantes."
    });
  }
});


// ======================================================
// FIREBASE AUTH — VALIDAÇÃO SEGURA DO USUÁRIO
// ======================================================

async function requireFirebaseAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Sessão Firebase não identificada."
    });
  }

  const idToken = authHeader.slice(7).trim();

  if (!idToken) {
    return res.status(401).json({
      error: "Token Firebase não informado."
    });
  }

  try {
    const decodedToken = await firebaseAuth.verifyIdToken(idToken);

    (req as any).firebaseUser = decodedToken;

    return next();

  } catch (error) {
    console.error(
      "[AUTH] Token Firebase inválido:",
      error
    );

    return res.status(401).json({
      error:
        "Sua sessão é inválida ou expirou. Entre novamente."
    });
  }
}

// ======================================================
// RATE LIMITING DURÁVEL E CONTROLE DE FLUXO (Vercel Serverless + Hash Anti-Vazamento)
// ======================================================
const inMemoryRateLimits = new Map<string, number[]>();

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  let timestamps = inMemoryRateLimits.get(key) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    inMemoryRateLimits.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  inMemoryRateLimits.set(key, timestamps);

  if (inMemoryRateLimits.size > 3000) {
    for (const [k, ts] of inMemoryRateLimits.entries()) {
      if (ts.every((t) => now - t > windowMs)) {
        inMemoryRateLimits.delete(k);
      }
    }
  }

  return true;
}

async function checkDurableRateLimit(
  rawKey: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  return checkAtomicDurableRateLimit(firestore, rawKey, maxRequests, windowMs);
}

// ======================================================
// ARQUITETURA TRANSACIONAL DE CRÉDITOS — LIVRO-RAZÃO (LEDGER)
// ======================================================
async function executeCreditDebitTransactional(params: {
  userRef: any;
  cost: number;
  xpAwarded: number;
  source: CreditLedgerRecord["source"];
  consultationId?: string;
  idempotencyKey?: string;
}) {
  return executeCreditDebitTransactionalCore(firestore, params);
}

async function executeCreditRefundTransactional(params: {
  userRef: any;
  amount: number;
  originalOperationId: string;
  source: CreditLedgerRecord["source"];
  reason: string;
}) {
  return executeCreditRefundTransactionalCore(firestore, params);
}


async function requireEmailVerified(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const firebaseUser = (req as any).firebaseUser as DecodedIdToken | undefined;
  if (!firebaseUser?.email_verified) {
    return res.status(403).json({
      code: "EMAIL_NOT_VERIFIED",
      error:
        "Confirmação de e-mail obrigatória para utilizar oráculos e consultas.",
    });
  }
  return next();
}

async function requirePortalUser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const firebaseUser =
    (req as any).firebaseUser as DecodedIdToken | undefined;

  if (!firebaseUser?.uid) {
    return res.status(401).json({
      error: "Sessão do usuário não identificada."
    });
  }

  try {
    let userDoc: any = null;

    // 1. Autoridade Exclusiva: Busca estrita por firebaseUid
    const uidSnapshot = await firestore
      .collection("users")
      .where("firebaseUid", "==", firebaseUser.uid)
      .limit(1)
      .get();

    if (!uidSnapshot.empty) {
      userDoc = uidSnapshot.docs[0];
    } else if (firebaseUser.email && firebaseUser.email_verified) {
      // 2. Migração segura de contas legadas SOMENTE com e-mail confirmado correspondente
      const emailSnapshot = await firestore
        .collection("users")
        .where("email", "==", firebaseUser.email.trim().toLowerCase())
        .limit(1)
        .get();

      if (!emailSnapshot.empty) {
        const potentialDoc = emailSnapshot.docs[0];
        const potentialData = potentialDoc.data() || {};

        if (!potentialData.firebaseUid) {
          await firestore.runTransaction(async (transaction: any) => {
            transaction.update(potentialDoc.ref, {
              firebaseUid: firebaseUser.uid,
              emailVerified: true,
              updatedAt: new Date().toISOString()
            });
          });
          userDoc = potentialDoc;
        }
      }
    }

    if (!userDoc || !userDoc.exists) {
      return res.status(404).json({
        error: "Buscador não encontrado no portal. Complete seu cadastro.",
        code: "USER_PROFILE_NOT_FOUND"
      });
    }

    const userData = userDoc.data() as any;

    if (userData.isBlocked) {
      return res.status(403).json({
        error: "Esta conta está suspensa das práticas do terreiro.",
        code: "USER_BLOCKED"
      });
    }

    if (
      userData?.firebaseUid &&
      userData.firebaseUid !== firebaseUser.uid
    ) {
      return res.status(403).json({
        error: "Esta sessão não pertence ao usuário informado.",
        code: "UID_MISMATCH"
      });
    }

    (req as any).portalUser = {
      id: userDoc.id,
      ref: userDoc.ref,
      ...userData
    };

    return next();
  } catch (error) {
    console.error("[AUTH] Falha ao validar usuário do portal:", error);
    return res.status(500).json({
      error: "Falha de validação de perfil. Tente novamente."
    });
  }
}

function requirePortalAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const portalUser = (req as any).portalUser as { role?: string } | undefined;

  if (portalUser?.role !== "admin") {
    return res.status(403).json({
      error: "Acesso administrativo restrito."
    });
  }

  return next();
}


// Helper to lazy-initialize the Gemini client
let geminiClientCache: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClientCache) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      throw new Error("GEMINI_API_KEY is not defined or is placeholder. Please add it to Secrets/Settings.");
    }
    geminiClientCache = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClientCache;
}

async function generateWithGeminiFallback(params: {
  contents: any;
  systemInstruction: string;
}): Promise<{ text: string; model: string; fallbackCount: number; fallbackReasons: string[] }> {
  const result = await executeGeminiWithFallback(getGeminiClient(), params);
  return {
    text: result.text,
    model: result.modelUsed,
    fallbackCount: result.fallbackCount,
    fallbackReasons: result.fallbackReasons,
  };
}













// Low-cost fallback logic if Gemini fails or is unconfigured to preserve premium interface

function getBrazilDateTime(requestedTimeZone?: string): any {
  const dtCtx = getUserDateTimeContext(requestedTimeZone);
  const now = new Date();

  const dayIndex = new Date(
    now.toLocaleString("en-US", { timeZone: dtCtx.timeZone })
  ).getDay();

  const regencies: Record<number, {
    orixa: string;
    saudacoes: string;
    cores: string;
    essencias: string;
    ervas: string;
    banhoTitulo: string;
    banhoDescritivo: string;
  }> = {
    0: {
      orixa: "Nanã Buruquê",
      saudacoes: "Saluba Nanã!",
      cores: "Violeta, lilás e tons de terra.",
      essencias: "Lavanda, cedro ou essência suave floral.",
      ervas: "Manjericão roxo, alfavaca e assa-peixe.",
      banhoTitulo: "Banho tradicional de calma e sabedoria",
      banhoDescritivo: "Use ervas suaves em água morna, do pescoço para baixo, mentalizando serenidade, ancestralidade e maturidade nas decisões."
    },
    1: {
      orixa: "Exu e Obaluaê/Omolu",
      saudacoes: "Laroyê Exu! Mojubá! / Atotô Obaluaê!",
      cores: "Vermelho, preto, branco e palha.",
      essencias: "Cravo, canela ou almíscar.",
      ervas: "Guiné, arruda e quebra-demanda.",
      banhoTitulo: "Banho tradicional de descarrego e abertura",
      banhoDescritivo: "Use guiné e arruda em maceração fria. Banhe-se do pescoço para baixo, pedindo limpeza, proteção e caminhos mais firmes."
    },
    2: {
      orixa: "Ogum",
      saudacoes: "Patacori Ogum! Ogunhê!",
      cores: "Azul escuro, verde e vermelho.",
      essencias: "Eucalipto, hortelã ou pinho.",
      ervas: "Aroeira, espada-de-ogum e losna.",
      banhoTitulo: "Banho tradicional de força e coragem",
      banhoDescritivo: "Use ervas de firmeza em água morna. Do pescoço para baixo, mentalize disciplina, proteção e atitude diante dos obstáculos."
    },
    3: {
      orixa: "Xangô e Iansã/Oyá",
      saudacoes: "Kaô Kabecilé Xangô! / Eparrey Iansã!",
      cores: "Marrom, vermelho, cobre e amarelo.",
      essencias: "Sândalo, patchouli ou verbena.",
      ervas: "Manjericão, quebra-pedra e erva de Santa Bárbara.",
      banhoTitulo: "Banho tradicional de justiça e decisão",
      banhoDescritivo: "Use manjericão em água fresca. Do pescoço para baixo, peça equilíbrio, clareza e coragem para decidir com justiça."
    },
    4: {
      orixa: "Oxóssi e Ossain",
      saudacoes: "Okê Arô Oxóssi! / Ewé Ó Ossain!",
      cores: "Verde, azul turquesa e tons de mata.",
      essencias: "Alecrim, capim-cidreira ou eucalipto.",
      ervas: "Alecrim, pitangueira e guiné.",
      banhoTitulo: "Banho tradicional de prosperidade e foco",
      banhoDescritivo: "Use alecrim em infusão leve. Do pescoço para baixo, mentalize fartura, inteligência, trabalho e boas oportunidades."
    },
    5: {
      orixa: "Oxalá",
      saudacoes: "Epà Babá Oxalá!",
      cores: "Branco, marfim e tons claros.",
      essencias: "Alfazema, lírio ou flor suave.",
      ervas: "Boldo, manjericão branco e rosas brancas.",
      banhoTitulo: "Banho tradicional de paz e equilíbrio",
      banhoDescritivo: "Macere folhas de boldo em água fria. Use do pescoço para baixo, buscando calma, clareza mental e paciência."
    },
    6: {
      orixa: "Oxum e Iemanjá",
      saudacoes: "Ora Yê Yê Ô Oxum! / Odoyá Iemanjá!",
      cores: "Dourado, amarelo, azul claro e branco.",
      essencias: "Jasmim, flor de laranjeira ou rosas.",
      ervas: "Camomila, melissa, erva-cidreira e rosas.",
      banhoTitulo: "Banho tradicional de amor-próprio e acolhimento",
      banhoDescritivo: "Use camomila e erva-cidreira em infusão suave. Do pescoço para baixo, mentalize cura emocional, amor-próprio e proteção."
    }
  };

  return {
    timeZone: dtCtx.timeZone,
    formattedDate: dtCtx.formattedDate,
    formattedTime: dtCtx.formattedTime,
    weekdayName: dtCtx.weekdayName,
    dateStr: dtCtx.dateStr,
    tomorrowDateStr: dtCtx.tomorrowDateStr,
    yesterdayDateStr: dtCtx.yesterdayDateStr,
    periodOfDay: dtCtx.periodOfDay,
    greeting: dtCtx.greeting,
    year: dtCtx.year,
    dayIndex,
    ...regencies[dayIndex]
  };
}

function fixPortugueseEncoding(text: string): string {
  if (!text) return "";

  return text
    .replace(/Ã¡/g, "á")
    .replace(/Ã /g, "à")
    .replace(/Ã¢/g, "â")
    .replace(/Ã£/g, "ã")
    .replace(/Ã©/g, "é")
    .replace(/Ãª/g, "ê")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ã´/g, "ô")
    .replace(/Ãµ/g, "õ")
    .replace(/Ãº/g, "ú")
    .replace(/Ã§/g, "ç")
    .replace(/Ã�/g, "Á")
    .replace(/Ã‰/g, "É")
    .replace(/Ã“/g, "Ó")
    .replace(/Ãš/g, "Ú")
    .replace(/Ã‡/g, "Ç");
}



const TEMPLE_FALLBACKS = [
  "Os caminhos se abrem para quem sabe silenciar a mente. O que realmente busca o seu coração, meu filho?",
  "A resposta não está no destino final, mas nos cruzamentos que escolhe percorrer. Exu vê suas encruzilhadas.",
  "O axé está nas suas mãos. Cada ação gera uma reação cósmica. Medite sob o equilíbrio do elemento que rege sua alma.",
  "Sábio é aquele que respeita o tempo do plantio e colhe com paciência. O oráculo indica que você deve agir com estratégia.",
  "Não dê passos maiores que suas pernas. Antes de agir, faça reverência aos que vieram antes de você."
];

// Initial pre-loaded spiritual library for RAG search
const DEFAULT_KNOWLEDGE: any[] = [
  {
    id: "kb_odu_1",
    title: "Éjì Ogbè (O Primeiro Odù)",
    category: "odu",
    content: "Éjì Ogbè é o pai de todos os Odùs. Simboliza a luz plena, a criação inicial, o dia iluminado e as forças benéficas da natureza. Traz mensagens de expansão, liderança, saúde física e caminhos totalmente abertos. Significa que a pessoa possui grande luz de proteção, mas deve cuidar contra orgulho e excesso de confiança. O elemento dominante é o Ar Cósmico. Regido por Oxalá, indica equilíbrio ético.",
    tags: ["odu", "eji ogbe", "caminhos", "luz", "paz", "inicio"]
  },
  {
    id: "kb_odu_2",
    title: "Òyẹ̀kú Méjì (O Segundo Odù)",
    category: "odu",
    content: "Òyẹ̀kú Méjì representa o anoitecer, os mistérios que habitam no oculto, a transição inevitável e a sabedoria dos ancestrais (Egungun). Traz aviso de cautela contra decisões apressadas e necessidade de proteção espiritual. Regido por Iemanjá e Obaluaê, pede paciência profunda, introspecção e o entendimento de que a escuridão é necessária para que o sol volte a brilhar plenamente no dia seguinte.",
    tags: ["odu", "oyeku", "mistério", "ancestralidade", "proteção"]
  },
  {
    id: "kb_odu_3",
    title: "Òbàrà Méjì (O Odù da Prosperidade e Alquimia)",
    category: "odu",
    content: "Òbàrà Méjì é o Odù da riqueza espiritual e material. Ensina que a riqueza nasce na sabedoria da mente e na moderação das palavras. Quem nasceu sob esse Odù precisa evitar a vaidade intelectual. Traz abundância após lutas e indica fertilidade nos negócios. Regido por Xangô e Oxóssi, este Odù ensina que o leão deve saber quando rugir e quando observar silenciosamente nas matas.",
    tags: ["odu", "obara", "prosperidade", "riqueza", "xango", "ouro", "sucesso"]
  },
  {
    id: "kb_exu_elegbara",
    title: "Exu Elegbara (Guardião dos Caminhos)",
    category: "orixa",
    content: "Exu Elegbara é a entidade e orixá do movimento, do dinamismo Cósmico, da comunicação e da ordem na desordem. Ele guarda as encruzilhadas físicas e espirituais da vida humana. Exu não é o mal; ele é o equilíbrio dinâmico, o mensageiro supremo entre o Orun (plano espiritual) e o Aiye (plano material). É o mestre estrategista, o diplomata do axé, que pune o descaso e premia o respeito e as oferendas sinceras de mente limpa.",
    tags: ["exu", "elegbara", "encruzilhada", "proteção", "caminho", "strategista"]
  },
  {
    id: "kb_pombagira_maria",
    title: "Pombagira Maria Padilha (Rainha das Encruzilhadas)",
    category: "entidade",
    content: "Maria Padilha é uma entidade mística que atua de forma poderosa na proteção afetiva, atração, quebra de magias negativas e justiça rápida para as injustiçadas. Caminha com respeito e empoderamento feminino. Simboliza a força que domina as adversidades com sorriso altivo, firmeza nos propósitos e clareza de convicção. Ensina a amar a si mesmo antes de entregar o coração nas mãos alheias.",
    tags: ["pombagira", "maria padilha", "amor", "justiça", "proteção", "autoestima"]
  },
  {
    id: "kb_filosofia_encruzilhada",
    title: "A Filosofia da Encruzilhada",
    category: "filosofia",
    content: "A encruzilhada representa o momento clássico de livre-arbítrio e escolha humana. Nas encruzilhadas residem os maiores mistérios cósmicos, pois toda decisão fecha alguns caminhos e escancara outros. A sabedoria espiritual ensina que, para cruzar com segurança, é indispensável estar em harmonia consigo e com o sagrado, ofertando pensamentos nobres, integridade moral e resiliência psicológica diante dos ventos mutáveis.",
    tags: ["encruzilhada", "escolhas", "filosofia", "sabedoria", "destino"]
  }

,
{
  id: "kb_ori_1",
  title: "Ori: cabeça, destino e escolha",
  category: "fundamento",
  content: "Ori é a cabeça física e espiritual do ser humano. Na tradição yorùbá, Ori-Inú é a cabeça interior, ligada ao destino, às escolhas e à realização pessoal. Antes de qualquer Orixá agir plenamente na vida de alguém, o Ori precisa estar alinhado. Ori ensina que destino não é passividade: a pessoa escolhe caminhos, constrói caráter e responde pelas consequências. O ensinamento central é Ìwà Lẹ́wà: caráter é beleza. Sem bom caráter, nenhum caminho permanece aberto por muito tempo.",
  tags: ["ori", "destino", "cabeca", "cabeça", "iwa", "carater", "caráter", "escolha", "ebori"]
},
{
  id: "kb_ifa_1",
  title: "Ifá e Orunmilá: sabedoria e orientação",
  category: "ifa",
  content: "Ifá é o sistema de sabedoria e orientação ligado a Orunmilá. Orunmilá é reconhecido como testemunha dos destinos e conhecedor dos caminhos humanos. Ifá não serve para alimentar fantasia, mas para orientar escolhas, revelar padrões, alertar riscos e indicar equilíbrio. Seus ensinamentos vêm por Odùs, versos, histórias, conselhos e fundamentos transmitidos pela tradição oral e sacerdotal.",
  tags: ["ifa", "orunmila", "orunmilá", "sabedoria", "destino", "oraculo", "oráculo", "odu"]
},
{
  id: "kb_odu_sistema_1",
  title: "Odù: caminho, destino e interpretação",
  category: "odu",
  content: "Odù não é signo astrológico nem rótulo fixo. Odù é caminho de interpretação dentro de Ifá. Cada Odù revela padrões, alertas, possibilidades, comportamentos, consequências e orientações. Tradicionalmente existem 16 Odùs principais, dos quais derivam os demais caminhos. O Odù não deve ser tratado como sentença absoluta, mas como mapa sagrado tradicional para compreender a vida, o caráter, os riscos e as escolhas.",
  tags: ["odu", "odus", "odù", "destino", "ifa", "caminho", "interpretação", "oraculo"]
},
{
  id: "kb_exu_2",
  title: "Exu como movimento, comunicação e axé",
  category: "exu",
  content: "Exu é princípio de movimento, comunicação, troca e circulação do axé. Nada se move sem Exu. Ele não representa o mal; representa dinamismo, passagem, mediação e consequência. Exu abre e fecha caminhos conforme respeito, intenção, troca e responsabilidade. Como mensageiro, liga o Aiyê ao Orun e faz circular pedidos, respostas e consequências.",
  tags: ["exu", "esu", "elegbara", "axé", "axe", "movimento", "comunicação", "caminhos", "orun", "aiye"]
},
{
  id: "kb_ejiogbe_livro_1",
  title: "Éjì Ogbè: início, luz e responsabilidade",
  category: "odu",
  content: "Éjì Ogbè é apresentado como o primeiro Odù e marca o início das coisas. Está ligado à luz, ao princípio, à expansão, à cabeça e aos caminhos de abertura. Mas sua luz também exige responsabilidade: quem carrega caminho aberto não deve agir com soberba, descuido ou pressa. Éjì Ogbè ensina que clareza sem caráter pode virar cegueira.",
  tags: ["odu", "eji ogbe", "ejì ogbè", "ogbe", "luz", "inicio", "início", "abertura", "responsabilidade"]
},

{
  id: "kb_obara_2",
  title: "Òbàrà Méjì: prosperidade, palavra e inteligência",
  category: "odu",
  content: "...",
  tags: ["odu", "obara", "òbàrà", "obara meji", "prosperidade", "riqueza", "dinheiro", "palavra", "inteligência", "comércio"]
},

{
  id: "kb_orunmila_2",
  title: "Orunmilá e o conhecimento do destino",
  category: "ifa",
  content: "Orunmilá é considerado testemunha da criação e conhecedor dos caminhos do destino humano. Seu conhecimento não existe para eliminar desafios, mas para ensinar como atravessá-los com sabedoria. Os ensinamentos de Ifá mostram que sorte sem caráter desaparece rapidamente, enquanto disciplina e consciência produzem prosperidade duradoura.",
  tags: ["orunmila", "orunmilá", "ifa", "destino", "sabedoria", "conhecimento"]
},
{
  id: "kb_iwa_pele",
  title: "Ìwà Pẹ̀lẹ́: o bom caráter",
  category: "fundamento",
  content: "Ìwà Pẹ̀lẹ́ significa bom caráter. Na tradição yorùbá, muitas conquistas dependem menos de força espiritual e mais da qualidade do caráter humano. Honestidade, respeito, equilíbrio emocional, palavra firme e responsabilidade fortalecem os caminhos. Sem Ìwà Pẹ̀lẹ́, o axé se torna instável.",
  tags: ["iwa", "iwapele", "ìwà", "caráter", "carater", "etica", "ética"]
},
{
  id: "kb_oyeku_2",
  title: "Òyẹ̀kú Méjì: ancestralidade e transformação",
  category: "odu",
  content: "Òyẹ̀kú Méjì fala sobre ciclos, ancestralidade, encerramentos e renascimentos. Ensina que algumas portas precisam ser fechadas para que outras possam ser abertas. É um Odù associado à sabedoria adquirida através da experiência, da paciência e da observação dos sinais da vida.",
  tags: ["oyeku", "òyẹ̀kú", "odu", "ancestralidade", "transformação", "egun"]
},
{
  id: "kb_exu_caminhos",
  title: "Exu e as encruzilhadas da vida",
  category: "exu",
  content: "As encruzilhadas representam momentos de decisão. Exu guarda esses pontos porque toda escolha cria consequências. Nem sempre a melhor porta é a mais bonita e nem sempre o caminho mais difícil é o errado. Exu ensina observação, estratégia e responsabilidade diante das escolhas.",
  tags: ["exu", "encruzilhada", "caminho", "escolha", "estrategia", "estratégia"]
}


,
{
  id: "kb_irosun_meji",
  title: "Ìrosùn Méjì: destino, ancestralidade e consequências",
  category: "odu",
  content: "Ìrosùn Méjì ensina que nenhuma ação desaparece. Tudo deixa marcas, produz consequências e retorna em algum momento. Este Odù está ligado à ancestralidade, ao aprendizado através da experiência e à necessidade de assumir responsabilidade pelos próprios atos. Alerta contra impulsividade, orgulho e repetição de erros antigos.",
  tags: ["irosun", "ìrosùn", "odu", "ancestralidade", "destino", "consequencia", "consequência"]
},
{
  id: "kb_odi_meji",
  title: "Òdí Méjì: proteção, limites e disciplina",
  category: "odu",
  content: "Òdí Méjì fala sobre proteção, preservação e limites. Ensina que nem toda porta deve ser aberta e nem toda oportunidade deve ser aceita. É um Odù associado à disciplina, prudência e estratégia. Sua principal lição é que força sem direção produz desperdício.",
  tags: ["odi", "òdí", "odu", "proteção", "limites", "disciplina", "estratégia"]
},
{
  id: "kb_oworin_meji",
  title: "Òwónrín Méjì: mudança, instabilidade e adaptação",
  category: "odu",
  content: "Òwónrín Méjì fala sobre mudanças rápidas, transformações inesperadas e necessidade de adaptação. Este Odù ensina que a vida raramente permanece estática. Quem resiste excessivamente às mudanças sofre mais do que quem aprende a se ajustar aos novos cenários.",
  tags: ["oworin", "òwónrín", "odu", "mudança", "transformação", "adaptação"]
},
{
  id: "kb_ogunda_meji",
  title: "Ògúndá Méjì: trabalho, conquista e perseverança",
  category: "odu",
  content: "Ògúndá Méjì está ligado ao trabalho, à luta, à conquista e à perseverança. Ensina que obstáculos existem para serem vencidos através de esforço, disciplina e coragem. É um Odù associado ao movimento constante e à construção sólida dos resultados.",
  tags: ["ogunda", "ògúndá", "odu", "trabalho", "conquista", "disciplina", "perseverança"]
}



,
{
  id: "kb_osa_meji",
  title: "Òsá Méjì: mudança, força feminina e ventos da transformação",
  category: "odu",
  content: "Òsá Méjì fala sobre ventos fortes, mudanças repentinas, força feminina, movimentos espirituais e necessidade de adaptação. Ensina que quando a vida começa a sacudir tudo, nem sempre é destruição: às vezes é limpeza, revelação e troca de direção. Alerta contra instabilidade emocional, orgulho e resistência ao movimento necessário.",
  tags: ["osa", "òsá", "odu", "mudança", "ventos", "transformação", "feminino", "oya", "iansa"]
},
{
  id: "kb_ika_meji",
  title: "Ìká Méjì: conflitos, venenos e inteligência diante do perigo",
  category: "odu",
  content: "Ìká Méjì fala sobre conflitos, armadilhas, venenos e discórdias sutis, disputas e palavras perigosas. Ensina que nem todo ataque deve ser respondido com ataque. Às vezes a inteligência está em observar, proteger-se e não alimentar aquilo que deseja nos destruir. Alerta contra fofoca, traição, impulsividade e decisões tomadas no calor da raiva.",
  tags: ["ika", "ìká", "odu", "conflito", "veneno", "traição", "fofoca", "proteção"]
},
{
  id: "kb_oturupon_meji",
  title: "Òtúrúpòn Méjì: profundidade, renascimento e correção de caminhos",
  category: "odu",
  content: "Òtúrúpòn Méjì fala sobre profundidade espiritual, crises que obrigam amadurecimento e necessidade de corrigir caminhos antes que a vida cobre mais caro. Este Odù ensina que certos problemas não se resolvem na superfície. É preciso descer à raiz, reconhecer erros antigos e reorganizar a própria conduta.",
  tags: ["oturupon", "òtúrúpòn", "odu", "renascimento", "profundidade", "correção", "crise"]
},
{
  id: "kb_otura_meji",
  title: "Òtúrá Méjì: clareza, elevação e abertura espiritual",
  category: "odu",
  content: "Òtúrá Méjì fala sobre clareza espiritual, expansão da consciência, comunicação com planos superiores e abertura de entendimento. Ensina que a luz precisa ser acompanhada de equilíbrio, humildade e disciplina. Quando a mente se abre sem fundamento, a pessoa confunde intuição com fantasia.",
  tags: ["otura", "òtúrá", "odu", "clareza", "espiritualidade", "intuição", "elevação"]
}

,
{
  id: "kb_irete_meji",
  title: "Ìretè Méjì: persistência, crescimento e construção lenta",
  category: "odu",
  content: "Ìretè Méjì fala sobre crescimento gradual, persistência e construção de bases sólidas. Ensina que aquilo que é feito com pressa pode cair com a mesma pressa. Este Odù valoriza disciplina, paciência e continuidade. Alerta contra ansiedade, instabilidade e desejo de colher antes de plantar corretamente.",
  tags: ["irete", "ìretè", "odu", "persistência", "crescimento", "paciência", "disciplina"]
},
{
  id: "kb_ose_meji",
  title: "Òsé Méjì: doçura, fertilidade e poder da palavra",
  category: "odu",
  content: "Òsé Méjì fala sobre fertilidade, beleza, doçura, encanto e poder criador da palavra. Ensina que a fala pode abrir portas ou fechar caminhos. A doçura verdadeira não é fraqueza: é inteligência emocional. Alerta contra manipulação, vaidade, sedução vazia e uso irresponsável da palavra.",
  tags: ["ose", "òsé", "odu", "fertilidade", "doçura", "palavra", "beleza", "oxum"]
},
{
  id: "kb_ofun_meji",
  title: "Òfún Méjì: sabedoria, maturidade e luz ancestral",
  category: "odu",
  content: "Òfún Méjì fala sobre sabedoria profunda, maturidade, ancestralidade elevada e luz espiritual. Ensina que nem toda luz é barulho: algumas verdades chegam em silêncio. Este Odù pede respeito aos mais velhos, prudência e limpeza de intenção. Alerta contra orgulho espiritual, rigidez e falsa pureza.",
  tags: ["ofun", "òfún", "odu", "sabedoria", "ancestralidade", "maturidade", "luz", "oxala"]
},
{
  id: "kb_iwori_meji",
  title: "Ìwòrì Méjì: consciência, visão interna e escolhas ocultas",
  category: "odu",
  content: "Ìwòrì Méjì fala sobre visão interna, consciência, segredos, dúvidas e escolhas que ainda não foram compreendidas. Ensina que antes de vencer o mundo externo, a pessoa precisa enxergar o que acontece dentro de si. Alerta contra confusão mental, fuga da verdade e decisões tomadas sem autoconhecimento.",
  tags: ["iwori", "ìwòrì", "odu", "consciência", "segredo", "visão", "autoconhecimento"]
},
{
  id: "kb_okanran_meji",
  title: "Òkànràn Méjì: começo difícil, impulso e palavra cortante",
  category: "odu",
  content: "Òkànràn Méjì fala sobre inícios difíceis, impulsividade, conflitos e força de ruptura. Ensina que nem toda porta se abre com delicadeza; às vezes a vida quebra estruturas para revelar um novo caminho. Mas este Odù alerta contra agressividade, pressa, fala cortante e decisões movidas por raiva.",
  tags: ["okanran", "òkànràn", "odu", "começo", "conflito", "impulso", "palavra", "raiva"]
}

,
{
  id: "kb_itan_exu_orunmila_1",
  title: "Itan: Exu e Orunmilá",
  category: "itan",
  content: "Um ensinamento recorrente em Ifá mostra que Exu está ligado à comunicação entre os mundos e à efetivação das trocas. Orunmilá conhece os destinos, mas Exu movimenta as mensagens, abre os caminhos e leva o axé ao seu destino. O ensinamento é claro: sabedoria sem movimento não realiza nada; movimento sem sabedoria vira confusão.",
  tags: ["itan", "exu", "orunmila", "orunmilá", "mensageiro", "caminho", "axé"]
},
{
  id: "kb_itan_ori_1",
  title: "Itan: Ori e a escolha do destino",
  category: "itan",
  content: "Na tradição yorùbá, conta-se que antes de vir ao Aiyê a pessoa escolhe seu Ori. Ori é a cabeça interior, a força que acompanha o ser humano em sua caminhada. O ensinamento é que ninguém caminha sem cabeça: antes de culpar o mundo, é preciso cuidar da própria direção, do próprio caráter e das próprias escolhas.",
  tags: ["itan", "ori", "destino", "escolha", "aiye", "orun", "caráter"]
},
{
  id: "kb_itan_obara_1",
  title: "Itan: Òbàrà e a inteligência da prosperidade",
  category: "itan",
  content: "Os ensinamentos ligados a Òbàrà mostram que a prosperidade exige inteligência, palavra correta e observação. A riqueza não chega apenas por desejo; ela se aproxima de quem sabe negociar, ouvir, esperar e agir. O ensinamento de Òbàrà é que dinheiro sem sabedoria escapa pelos dedos.",
  tags: ["itan", "obara", "òbàrà", "prosperidade", "riqueza", "dinheiro", "sabedoria"]
},
{
  id: "kb_itan_ejiogbe_1",
  title: "Itan: Éjì Ogbè e a responsabilidade da luz",
  category: "itan",
  content: "Éjì Ogbè fala da luz que inaugura caminhos. Mas a luz não serve apenas para mostrar bênçãos; ela também revela falhas, vaidades e responsabilidades. O ensinamento é que quem pede caminhos abertos precisa ter maturidade para atravessá-los sem transformar clareza em arrogância.",
  tags: ["itan", "eji ogbe", "ejì ogbè", "luz", "caminhos", "responsabilidade"]
}

,
{
  id: "kb_orixa_oxala",
  title: "Oxalá: criação, equilíbrio e responsabilidade",
  category: "orixa",
  content: "Oxalá é associado à criação, à ética, à serenidade e à construção consciente da vida. Seus ensinamentos mostram que força verdadeira não é gritar mais alto, mas sustentar o equilíbrio quando tudo ao redor perde a direção. Oxalá ensina paciência, responsabilidade e clareza moral. Caminhos construídos sem ética podem crescer rapidamente, mas raramente permanecem firmes por muito tempo.",
  tags: ["oxala", "oxalá", "criacao", "criação", "equilibrio", "ética", "sabedoria"]
},
{
  id: "kb_orixa_ogum",
  title: "Ogum: conquista, trabalho e abertura de caminhos",
  category: "orixa",
  content: "Ogum é o senhor dos caminhos conquistados pelo esforço. Representa coragem, tecnologia, estratégia, disciplina e ação concreta. Seus ensinamentos mostram que sonhos sem ação permanecem apenas como imaginação. Ogum ensina que obstáculos existem para serem vencidos e que a vitória normalmente pertence aos que continuam avançando quando outros já desistiram.",
  tags: ["ogum", "trabalho", "caminhos", "conquista", "coragem", "disciplina"]
},
{
  id: "kb_orixa_oxossi",
  title: "Oxóssi: conhecimento, caça e estratégia",
  category: "orixa",
  content: "Oxóssi é o caçador que encontra aquilo que procura porque observa antes de agir. Está ligado ao conhecimento, à inteligência, à pesquisa, ao aprendizado e à estratégia. Seu ensinamento é que nem toda batalha é vencida pela força. Muitas vezes a vitória pertence àquele que enxerga o alvo antes dos demais.",
  tags: ["oxossi", "oxóssi", "conhecimento", "estratégia", "caçador", "aprendizado"]
},
{
  id: "kb_orixa_xango",
  title: "Xangô: justiça, poder e responsabilidade",
  category: "orixa",
  content: "Xangô representa justiça, equilíbrio, liderança e responsabilidade. Seus ensinamentos mostram que poder sem caráter se transforma em abuso. A verdadeira autoridade nasce da capacidade de julgar com equilíbrio, ouvir diferentes lados e agir com consciência das consequências.",
  tags: ["xango", "xangô", "justiça", "liderança", "poder", "equilíbrio"]
},
{
  id: "kb_orixa_oya",
  title: "Oyá: transformação, coragem e movimento",
  category: "orixa",
  content: "Oyá governa ventos, mudanças e transformações. Seus ensinamentos mostram que a vida se move em ciclos e que resistir eternamente à mudança apenas aumenta o sofrimento. Oyá ensina coragem para abandonar o que terminou e força para atravessar novos caminhos.",
  tags: ["oya", "oyá", "iansa", "mudança", "transformação", "coragem"]
},
{
  id: "kb_orixa_yemanja",
  title: "Yemanjá: maternidade, acolhimento e profundidade",
  category: "orixa",
  content: "Yemanjá está associada à maternidade, proteção, acolhimento e profundidade emocional. Seus ensinamentos mostram que sensibilidade não é fraqueza. Quem compreende as emoções humanas enxerga camadas da realidade que passam despercebidas para muitos.",
  tags: ["yemanja", "yemanjá", "proteção", "acolhimento", "família", "emoções"]
},
{
  id: "kb_orixa_oxum",
  title: "Oxum: prosperidade, beleza e inteligência emocional",
  category: "orixa",
  content: "Oxum governa prosperidade, fertilidade, diplomacia, beleza e inteligência emocional. Seus ensinamentos mostram que a suavidade pode ser mais poderosa que a agressividade. Oxum ensina que riqueza não é apenas dinheiro; riqueza também é saber cultivar relacionamentos, oportunidades e equilíbrio emocional.",
  tags: ["oxum", "prosperidade", "fertilidade", "beleza", "riqueza", "emocional"]
},
{
  id: "kb_orixa_oxumare",
  title: "Oxumaré: ciclos, transformação e renovação",
  category: "orixa",
  content: "Oxumaré representa os ciclos da vida, a renovação constante, o movimento entre diferentes estados e a transformação contínua. Seus ensinamentos mostram que tudo muda. Prosperidade e dificuldade são fases. O importante é aprender a atravessar cada ciclo sem perder a própria essência.",
  tags: ["oxumare", "oxumaré", "ciclos", "transformação", "renovação", "movimento"]
},
{
  id: "kb_orixa_nana",
  title: "Nanã: ancestralidade, sabedoria e tempo",
  category: "orixa",
  content: "Nanã está ligada à ancestralidade, à memória, à experiência e ao tempo. Seus ensinamentos mostram que algumas respostas não chegam pela velocidade, mas pela maturidade. Nanã ensina respeito às origens, aos mais velhos e aos ciclos naturais da existência.",
  tags: ["nana", "nanã", "ancestralidade", "tempo", "sabedoria", "memória"]
},
{
  id: "kb_orixa_ossain",
  title: "Ossain: folhas, cura e conhecimento oculto",
  category: "orixa",
  content: "Ossain governa as folhas, os segredos da natureza e os conhecimentos ocultos da cura. Seus ensinamentos mostram que a natureza guarda respostas que muitos ignoram. Ossain ensina observação, respeito pelos ciclos naturais e busca constante por conhecimento verdadeiro.",
  tags: ["ossain", "folhas", "cura", "natureza", "conhecimento", "segredos"]
}

,
{
  id: "kb_proverbio_1",
  title: "Provérbio de Ifá: o caminho e os pés",
  category: "proverbio",
  content: "Ifá ensina que nenhum caminho se abre para quem se recusa a caminhar. O destino pode mostrar oportunidades, mas são os pés que atravessam a estrada. A oportunidade sem ação se transforma em arrependimento.",
  tags: ["proverbio", "ifa", "caminho", "ação", "destino", "oportunidade"]
},
{
  id: "kb_proverbio_2",
  title: "Provérbio de Ifá: caráter antes da riqueza",
  category: "proverbio",
  content: "A riqueza pode visitar qualquer pessoa. Permanecer é outra história. Ifá ensina que dinheiro sem caráter produz destruição, enquanto caráter sólido constrói prosperidade duradoura.",
  tags: ["proverbio", "ifa", "riqueza", "caráter", "prosperidade", "dinheiro"]
},
{
  id: "kb_proverbio_3",
  title: "Provérbio de Ifá: ouvir antes de falar",
  category: "proverbio",
  content: "Quem fala antes de ouvir revela ignorância. Quem observa antes de responder revela sabedoria. Muitas derrotas começam pela língua e não pelas mãos.",
  tags: ["proverbio", "sabedoria", "fala", "escuta", "observação"]
},
{
  id: "kb_proverbio_4",
  title: "Provérbio de Exu: toda escolha cobra um preço",
  category: "proverbio",
  content: "Exu ensina que não existem escolhas sem consequências. Algumas portas cobram na entrada. Outras cobram na saída. O sábio calcula o preço antes de atravessar a encruzilhada.",
  tags: ["exu", "encruzilhada", "escolha", "consequência", "caminho"]
},
{
  id: "kb_proverbio_5",
  title: "Provérbio de Ori: ninguém vence contra a própria cabeça",
  category: "proverbio",
  content: "O maior aliado e o maior inimigo de uma pessoa podem habitar a mesma cabeça. Quem organiza os pensamentos organiza os caminhos. Quem vive em confusão interna encontra obstáculos até em portas abertas.",
  tags: ["ori", "mente", "cabeça", "destino", "pensamentos"]
},
{
  id: "kb_fundamento_ebo",
  title: "Fundamento do Ebó",
  category: "fundamento",
  content: "Ebó não é compra de milagres. Ebó é movimento, correção, alinhamento e troca sagrada tradicional. O ensinamento tradicional mostra que o ebó funciona junto com mudança de comportamento, responsabilidade e consciência.",
  tags: ["ebo", "ebó", "ifa", "fundamento", "troca", "caminho"]
},
{
  id: "kb_fundamento_destino",
  title: "Destino e livre-arbítrio",
  category: "fundamento",
  content: "A tradição de Ifá ensina que destino e escolha caminham juntos. Existem tendências, potenciais e desafios. Mas a forma como a pessoa responde aos acontecimentos influencia profundamente o resultado da jornada.",
  tags: ["destino", "livre arbitrio", "ifa", "ori", "escolhas"]
},
{
  id: "kb_fundamento_exu",
  title: "Exu não é o mal",
  category: "fundamento",
  content: "Na tradição yorùbá, Exu não representa o mal absoluto. Exu representa movimento, comunicação, consequência, equilíbrio e dinamismo. Muitas interpretações negativas surgiram por influência de traduções equivocadas e sincretismos históricos.",
  tags: ["exu", "elegbara", "fundamento", "yoruba", "movimento"]
}


,
{
  id: "kb_itan_exu_primeiro_movimento",
  title: "Itan: Exu e o primeiro movimento",
  category: "itan",
  content: "Um ensinamento tradicional apresenta Exu como força indispensável para que qualquer ato se realize. Antes da fala chegar ao destino, antes da oferenda alcançar seu caminho, antes da decisão virar consequência, Exu movimenta a passagem. O fundamento é simples: intenção parada não produz resultado. Exu ensina que todo pedido precisa de caminho, toda palavra precisa de direção e toda escolha cobra responsabilidade.",
  tags: ["itan", "exu", "movimento", "mensageiro", "axé", "caminho", "fundamento"]
},
{
  id: "kb_itan_exu_nao_e_demonio",
  title: "Itan: Exu e a falsa imagem do mal",
  category: "itan",
  content: "Muitos confundiram Exu com o mal por ignorância, medo ou tradução equivocada. Na tradição yorùbá, Exu não é demônio. Ele é princípio de movimento, comunicação, troca, consequência e fiscalização das escolhas. Quando alguém age com descaso, Exu revela o descaso. Quando alguém age com respeito, Exu abre passagem. O ensinamento é que Exu não cria a maldade humana; ele apenas mostra o preço dela.",
  tags: ["itan", "exu", "elegbara", "demonio", "demônio", "mal", "yoruba", "fundamento"]
},
{
  id: "kb_itan_orunmila_filhos_ikin",
  title: "Itan: Orunmilá, seus filhos e os ikin",
  category: "itan",
  content: "Conta-se que quando Orunmilá retornou ao Orun, a Terra caiu em desordem. Seus filhos foram buscá-lo, mas ele não voltou como antes. Em vez disso, entregou a eles os ikin, as nozes sagradas de Ifá, para que pudessem consultá-lo e receber orientação. O ensinamento é profundo: a sabedoria verdadeira não cria dependência cega; ela deixa método, disciplina e responsabilidade para quem precisa caminhar.",
  tags: ["itan", "orunmila", "orunmilá", "ikin", "ifa", "sabedoria", "destino", "consulta"]
},
{
  id: "kb_itan_ori_obe_axé",
  title: "Itan: Ori e o Obi do Axé",
  category: "itan",
  content: "Um ensinamento sobre Ori conta que muitas divindades tentaram abrir o Obi do Axé, mas somente Ori conseguiu, porque foi o único que cumpriu corretamente a orientação recebida. Por isso Ori recebeu posição elevada. A lição é direta: antes de pedir poder, é preciso ter disciplina. Antes de pedir destino bonito, é preciso cuidar da própria cabeça, da própria conduta e das próprias escolhas.",
  tags: ["itan", "ori", "obi", "axé", "destino", "disciplina", "caráter"]
},
{
  id: "kb_itan_ori_acompanha",
  title: "Itan: somente Ori acompanha até o fim",
  category: "itan",
  content: "Um ensinamento de Ifá diz que Orunmilá perguntou qual força acompanharia seu devoto até qualquer lugar sem abandoná-lo. Nenhum Orixá respondeu corretamente. A resposta era Ori. Somente Ori acompanha a pessoa por todos os caminhos, porque Ori é sua cabeça, seu destino interior e sua direção íntima. O ensinamento é que ninguém vence a vida estando em guerra contra a própria cabeça.",
  tags: ["itan", "ori", "orunmila", "orunmilá", "destino", "cabeça", "caminho"]
},
{
  id: "kb_itan_ejiogbe_terra_agua_praca",
  title: "Itan: Éjì Ogbè, Terra, Água e Praça",
  category: "itan",
  content: "Em um ensinamento ligado a Éjì Ogbè, Terra, Água e Praça disputavam quem era mais importante. A resposta ensinou que nenhuma delas bastava sozinha: a Terra produz, a Água alimenta e a Praça permite a troca. O ensinamento é que prosperidade exige cooperação entre base, fluxo e circulação. Quem quer crescer precisa cuidar do que planta, do que nutre e de onde troca.",
  tags: ["itan", "eji ogbe", "ejì ogbè", "terra", "agua", "água", "praça", "prosperidade", "troca"]
},
{
  id: "kb_itan_ejiogbe_iku_ovos",
  title: "Itan: Éjì Ogbè e o caçador diante de Ikú",
  category: "itan",
  content: "Um itan de Éjì Ogbè fala de um caçador que recebeu orientação para fazer ebó antes de entrar na mata, mas ignorou o conselho. No caminho encontrou Ikú disfarçada e acabou pagando caro por não respeitar o aviso. O ensinamento não é medo: é prudência. Quando a vida avisa, a teimosia pode transformar risco pequeno em perda grande.",
  tags: ["itan", "eji ogbe", "ejì ogbè", "iku", "ikú", "caçador", "prudência", "aviso"]
},
{
  id: "kb_itan_obara_prosperidade",
  title: "Itan: Òbàrà Méjì e a prosperidade com sabedoria",
  category: "itan",
  content: "Òbàrà Méjì ensina que prosperidade não é apenas receber dinheiro. É saber pensar, falar, negociar, guardar, circular e agir no momento certo. A riqueza que chega sem sabedoria pode se perder na vaidade, na pressa ou na língua solta. Òbàrà ensina que a palavra é uma ferramenta de construção ou destruição. Quem fala sem medida perde oportunidades antes mesmo de vê-las chegar.",
  tags: ["itan", "obara", "òbàrà", "prosperidade", "riqueza", "palavra", "dinheiro", "sabedoria"]
},
{
  id: "kb_itan_iwa_carater",
  title: "Itan: Ìwà, caráter e beleza",
  category: "itan",
  content: "A tradição ensina que Ìwà Lẹ́wà: caráter é beleza. Uma pessoa pode ter caminho, proteção, inteligência e oportunidade, mas se não tiver caráter, destrói o próprio axé. O bom caráter não é enfeite moral; é fundamento espiritual. Quem mente para todos acaba criando uma vida onde ninguém confia, nem mesmo os caminhos.",
  tags: ["itan", "iwa", "ìwà", "caráter", "carater", "ética", "conduta", "fundamento"]
},
{
  id: "kb_itan_ajala_ori",
  title: "Itan: Àjàlá e a escolha da cabeça",
  category: "itan",
  content: "Conta-se que Àjàlá molda as cabeças antes da vinda ao Aiyê. Cada pessoa escolhe seu Ori antes de nascer, mas precisa cuidar dele durante a vida. Algumas cabeças chegam firmes, outras chegam frágeis, e o caminho humano exige restauração, disciplina e consciência. O ensinamento é que destino não dispensa esforço: até uma boa cabeça precisa ser bem conduzida.",
  tags: ["itan", "ajala", "àjàlá", "ori", "cabeça", "destino", "aiye", "orun"]
},
{
  id: "kb_fundamento_bori",
  title: "Bori: cuidar da cabeça",
  category: "fundamento",
  content: "Bori significa alimentar, cuidar e fortalecer Ori. Em sentido cultural e tradicional, ensina que a cabeça precisa de equilíbrio antes de grandes decisões. Quando a mente está confusa, até caminho aberto parece labirinto. O fundamento do Bori mostra que cuidar de Ori é cuidar da direção da própria vida.",
  tags: ["bori", "ebori", "ori", "cabeça", "equilíbrio", "destino", "fundamento"]
},
{
  id: "kb_fundamento_oriki",
  title: "Oríkì: louvor, memória e identidade",
  category: "fundamento",
  content: "Oríkì é louvação, evocação e memória. Na tradição yorùbá, a palavra carrega força, história e identidade. Um Oríkì não é apenas elogio; é chamado de essência, recordação de linhagem e ativação espiritual de presença. O ensinamento é que palavra bem usada organiza o mundo; palavra vazia desperdiça axé.",
  tags: ["oriki", "oríkì", "louvor", "palavra", "ancestralidade", "memória", "identidade"]
},
{
  id: "kb_fundamento_ese_ifa",
  title: "Èse Ifá: poema, conselho e estrutura",
  category: "fundamento",
  content: "Èse Ifá são poemas ligados aos Odùs. Eles apresentam histórias, situações, erros, conselhos, oferendas e preceitos tradicionais, consequências e aprendizados. Sua função é orientar o consulente a se reconhecer no ensinamento. O valor do Èse não está apenas na narrativa, mas na capacidade de revelar um padrão humano que se repete.",
  tags: ["ese", "èse", "ifa", "poema", "odu", "ensinamento", "conselho", "itan"]
},
{
  id: "kb_fundamento_egun",
  title: "Egungun e ancestralidade",
  category: "fundamento",
  content: "Egungun está ligado aos ancestrais e à memória espiritual dos que vieram antes. A ancestralidade ensina que ninguém nasce sozinho: cada pessoa carrega histórias, dívidas, forças e caminhos herdados. Honrar ancestralidade não é viver preso ao passado, mas reconhecer as raízes para caminhar com mais consciência.",
  tags: ["egun", "egungun", "ancestralidade", "ancestrais", "memória", "família"]
},
{
  id: "kb_fundamento_aiye_orun",
  title: "Aiyê e Orun: mundo visível e invisível",
  category: "fundamento",
  content: "Aiyê é o mundo visível, a vida concreta, o chão onde a escolha acontece. Orun é o mundo invisível, espiritual, onde habitam forças, ancestrais e princípios sagrados. A tradição ensina que esses mundos se comunicam. O ser humano vive no Aiyê, mas suas escolhas ecoam também no Orun.",
  tags: ["aiye", "aiyê", "orun", "mundo", "espiritual", "yoruba", "fundamento"]
}


,
{
  id: "kb_exu_odara",
  title: "Exu Odara: comunicação, encanto e caminho favorável",
  category: "exu",
  content: "Exu Odara está ligado à comunicação favorável, à diplomacia, ao encanto e à capacidade de abrir passagem com inteligência. Odara lembra que nem toda porta se arromba; algumas se abrem com palavra certa, presença firme e movimento bem calculado. Seu ensinamento é saber negociar com a vida sem perder a própria direção.",
  tags: ["exu", "odara", "comunicação", "diplomacia", "caminho", "encanto"]
},
{
  id: "kb_exu_lonan",
  title: "Exu Lonan: senhor dos caminhos",
  category: "exu",
  content: "Exu Lonan está ligado aos caminhos, passagens e direções. Ele ensina que cada estrada tem exigências próprias. Não basta desejar chegar: é preciso saber por onde se anda, com quem se caminha e o que se carrega. Seu fundamento fala de orientação, movimento e atenção aos sinais da estrada.",
  tags: ["exu", "lonan", "caminhos", "estrada", "direção", "passagem"]
},
{
  id: "kb_exu_alaketu",
  title: "Exu Alaketu: força ancestral e comunicação ritual",
  category: "exu",
  content: "Exu Alaketu representa força ancestral, comunicação ritual e ligação com fundamentos antigos. Ensina que tradição não é enfeite: é raiz, método e responsabilidade. Quem chama caminho sem respeito ao fundamento corre o risco de confundir movimento com desordem.",
  tags: ["exu", "alaketu", "ancestralidade", "tradição", "ritual", "fundamento"]
},
{
  id: "kb_exu_bara",
  title: "Bará: movimento do corpo, desejo e realização",
  category: "exu",
  content: "Bará está ligado ao movimento vital, ao corpo, aos impulsos, ao desejo e à realização no mundo concreto. Ensina que espiritualidade sem corpo vira abstração. O caminho também passa pelo trabalho, pela fome, pelo dinheiro, pelo desejo, pela fala e pela troca.",
  tags: ["bara", "bará", "exu", "corpo", "desejo", "movimento", "troca"]
},
{
  id: "kb_exu_orita",
  title: "Exu Oritá: encruzilhada e decisão",
  category: "exu",
  content: "Exu Oritá está ligado à encruzilhada, ao ponto onde caminhos se cruzam e escolhas precisam ser feitas. Ele ensina que ficar parado também é uma escolha. A encruzilhada não decide pela pessoa; ela apenas revela que não há como seguir por todos os caminhos ao mesmo tempo.",
  tags: ["exu", "orita", "oritá", "encruzilhada", "decisão", "escolha"]
},
{
  id: "kb_exu_yangi",
  title: "Exu Yangi: princípio primordial e força bruta do movimento",
  category: "exu",
  content: "Exu Yangi é associado ao princípio primordial de Exu, força original, pedra fundamental e potência inicial do movimento. Ele lembra que antes da forma existe o impulso; antes da estrada existe a abertura. Seu ensinamento é que toda criação precisa de uma primeira força que rompa a inércia.",
  tags: ["exu", "yangi", "primordial", "movimento", "origem", "força"]
},
{
  id: "kb_pombagira_fundamento",
  title: "Pombagira: desejo, palavra e autonomia",
  category: "entidade",
  content: "Pombagira trabalha com os fundamentos do desejo, autoestima, palavra, sedução, autonomia e relações humanas. Seu ensinamento não é manipular o amor alheio, mas compreender onde a pessoa se abandona em nome de ser desejada. Ela ensina presença, limite, dignidade e domínio da própria narrativa.",
  tags: ["pombagira", "desejo", "amor", "autoestima", "limite", "relações"]
},
{
  id: "kb_pombagira_padilha_2",
  title: "Maria Padilha: estratégia afetiva e verdade emocional",
  category: "entidade",
  content: "Maria Padilha personifica a inteligência afetiva, domínio da palavra, magnetismo e coragem para enxergar verdades nas relações. Ela não ensina submissão ao desejo alheio. Ensina que amor sem dignidade vira prisão, e paixão sem consciência vira dívida emocional.",
  tags: ["maria padilha", "pombagira", "amor", "relações", "dignidade", "verdade"]
},
{
  id: "kb_tranca_rua",
  title: "Exu Tranca Rua: limites, portas e proteção",
  category: "entidade",
  content: "Exu Tranca Rua é associado aos limites, às portas, aos caminhos fechados e abertos, à proteção e à ordenação da passagem. Seu ensinamento é que nem toda porta fechada é castigo; às vezes é proteção. Ele mostra quando insistir virou teimosia e quando recuar é estratégia.",
  tags: ["tranca rua", "exu", "proteção", "porta", "limite", "caminho"]
},
{
  id: "kb_exu_marabo",
  title: "Exu Marabô: inteligência, elegância e estratégia",
  category: "entidade",
  content: "Exu Marabô é associado à inteligência, elegância, estratégia, domínio da palavra e leitura fina das situações humanas. Seu ensinamento é agir com classe sem perder firmeza. Marabô observa antes de falar e fala para produzir efeito.",
  tags: ["marabo", "marabô", "exu", "estratégia", "palavra", "inteligência"]
},
{
  id: "kb_exu_tiriri",
  title: "Exu Tiriri: rapidez, corte e esperteza",
  category: "entidade",
  content: "Exu Tiriri é associado à rapidez, esperteza, corte de demandas e movimento ágil. Seu ensinamento é não dormir diante do perigo. Mas rapidez não é desespero: é percepção afiada, resposta precisa e ação no momento certo.",
  tags: ["tiriri", "exu", "rapidez", "corte", "demanda", "esperteza"]
},
{
  id: "kb_exu_caveira",
  title: "Exu Caveira: finitude, verdade e desapego",
  category: "entidade",
  content: "Exu Caveira trabalha com os mistérios da finitude, fim de ciclos, verdade nua e desapego. Seu ensinamento é lembrar que tudo que nasce também termina. Quem entende a finitude para de desperdiçar vida com ilusão, vaidade e medo.",
  tags: ["caveira", "exu", "morte", "finitude", "desapego", "verdade"]
},
{
  id: "kb_exu_meia_noite",
  title: "Exu Meia-Noite: limiar, silêncio e revelação",
  category: "entidade",
  content: "Exu Meia-Noite está ligado aos limiares, ao silêncio, aos momentos de virada e às verdades que aparecem quando o barulho do mundo diminui. Seu ensinamento é que algumas respostas só chegam quando a pessoa para de fugir de si mesma.",
  tags: ["meia noite", "exu", "silêncio", "limiar", "revelação", "verdade"]
}


,
{
  id: "kb_tema_prosperidade",
  title: "Prosperidade segundo Ifá",
  category: "tema",
  content: "A prosperidade, nos ensinamentos de Ifá, não é apenas acumulação de dinheiro. Ela envolve equilíbrio entre recursos, caráter, oportunidades, trabalho e inteligência. Muitos Odùs ensinam que riqueza sem sabedoria gera perda, enquanto disciplina e visão produzem abundância duradoura. Prosperidade é consequência de alinhamento entre pensamento, palavra e ação.",
  tags: ["prosperidade", "riqueza", "dinheiro", "abundância", "financeiro", "trabalho"]
},
{
  id: "kb_tema_caminhos_fechados",
  title: "Caminhos fechados e bloqueios",
  category: "tema",
  content: "Nem todo caminho fechado representa ataque espiritual. Muitas vezes o bloqueio surge de decisões repetidas, medo, falta de preparo, impulsividade ou insistência em direções inadequadas. A tradição ensina que antes de procurar inimigos invisíveis é preciso observar padrões visíveis. Alguns obstáculos são proteção. Outros são convite para mudança.",
  tags: ["caminho fechado", "bloqueio", "travamento", "obstáculo", "dificuldade", "proteção"]
},
{
  id: "kb_tema_amor",
  title: "Amor, relacionamentos e escolhas",
  category: "tema",
  content: "Os ensinamentos tradicionais mostram que relacionamento não é apenas encontro de sentimentos. É encontro de destinos, escolhas, caráteres e responsabilidades. O amor saudável fortalece a identidade. O amor desequilibrado exige que alguém abandone a si mesmo. Muitas dores afetivas surgem quando desejo e realidade caminham em direções opostas.",
  tags: ["amor", "relacionamento", "casamento", "paixão", "sentimentos", "união"]
},
{
  id: "kb_tema_inveja",
  title: "Inveja e energia destrutiva",
  category: "tema",
  content: "A inveja aparece em diversas tradições como força corrosiva. Porém, nem toda dificuldade nasce da inveja alheia. Muitas vezes o medo da inveja é usado para evitar responsabilidades pessoais. A sabedoria ensina equilíbrio: proteger-se sem paranoia, vigiar-se sem obsessão e fortalecer-se antes de procurar culpados.",
  tags: ["inveja", "olho gordo", "energia negativa", "proteção", "demanda"]
},
{
  id: "kb_tema_trabalho",
  title: "Trabalho e construção de destino",
  category: "tema",
  content: "O trabalho ocupa posição central em muitos ensinamentos ligados a Ogum e aos Odùs de conquista. O destino não é construído apenas por inspiração espiritual. É construído por ação repetida, aprendizado constante e capacidade de suportar períodos difíceis sem abandonar o objetivo principal.",
  tags: ["trabalho", "carreira", "emprego", "negócio", "conquista", "profissão"]
},
{
  id: "kb_tema_medo",
  title: "Medo e paralisação",
  category: "tema",
  content: "O medo protege quando alerta para riscos reais. Mas destrói quando impede movimento necessário. Muitos caminhos permanecem fechados não por falta de oportunidade, mas porque a pessoa tenta eliminar todo risco antes de agir. A tradição ensina prudência, não imobilidade.",
  tags: ["medo", "paralisia", "travamento", "coragem", "ação", "risco"]
},
{
  id: "kb_tema_sucesso",
  title: "Sucesso e responsabilidade",
  category: "tema",
  content: "Muitas pessoas acreditam desejar sucesso, mas temem as responsabilidades que o acompanham. Prosperidade exige gestão. Liderança exige cobrança. Reconhecimento exige exposição. Os ensinamentos tradicionais alertam que o crescimento verdadeiro traz benefícios e deveres ao mesmo tempo.",
  tags: ["sucesso", "crescimento", "liderança", "prosperidade", "responsabilidade"]
},
{
  id: "kb_tema_destino",
  title: "Destino, escolhas e consequências",
  category: "tema",
  content: "O destino não é visto como prisão absoluta. Ele representa tendências, potenciais e caminhos possíveis. As escolhas diárias influenciam a forma como esses potenciais se manifestam. A pessoa não controla tudo o que acontece, mas participa ativamente da forma como responde aos acontecimentos.",
  tags: ["destino", "escolhas", "ori", "livre arbitrio", "consequências"]
},
{
  id: "kb_tema_espiritualidade",
  title: "Espiritualidade e vida prática",
  category: "tema",
  content: "Espiritualidade não existe apenas para responder perguntas sobre o invisível. Ela também ajuda a organizar a vida visível. Os ensinamentos de Ifá mostram que fé sem ação enfraquece, mas ação sem consciência também produz desequilíbrio. O caminho mais forte une fundamento e prática.",
  tags: ["espiritualidade", "fé", "vida", "orixa", "ifa", "equilíbrio"]
},
{
  id: "kb_tema_autoconhecimento",
  title: "Autoconhecimento e verdade",
  category: "tema",
  content: "Grande parte das dificuldades humanas nasce da distância entre aquilo que a pessoa é e aquilo que ela acredita ser. O autoconhecimento não serve para alimentar ego. Serve para revelar padrões ocultos, corrigir rotas e permitir escolhas mais conscientes. A verdade pode ser desconfortável, mas costuma ser libertadora.",
  tags: ["autoconhecimento", "verdade", "consciência", "ori", "crescimento"]
},

{
  id: "kb_exus_reinos",
  title: "100 Exus e seus Reinos",
  category: "exu",
  tags: [
    "exu",
    "exus",
    "tranca ruas",
    "marabo",
    "tiriri",
    "veludo",
    "caveira",
    "morcego",
    "reinos",
    "falanges",
    "encruzilhadas",
    "calunga",
    "almas",
    "lira",
    "praia",
    "estradas",
    "cruzeiros",
    "matas",
    "pedreiras"
  ],
  content: `
Exu Rei das 7 Encruzilhadas — Reino das Encruzilhadas
Exu Rei da Encruzilhada — Reino das Encruzilhadas
Exu Tranca Ruas das 7 Encruzilhadas — Reino das Encruzilhadas
Exu Tranca Ruas — Reino das Encruzilhadas
Exu Tranca Ruas das Almas — Reino das Almas
Exu Tranca Ruas da Calunga — Reino da Calunga
Exu Tranca Ruas da Lira — Reino da Lira
Exu Tranca Ruas da Praia — Reino da Praia
Exu Tranca Ruas das Matas — Reino das Matas
Exu Tranca Ruas das Estradas — Reino das Estradas
Exu Marabô — Reino das Encruzilhadas
Exu Marabô das Almas — Reino das Almas
Exu Marabô da Calunga — Reino da Calunga
Exu Marabô da Estrada — Reino das Estradas
Exu Marabô da Praia — Reino da Praia
Exu Marabô da Lira — Reino da Lira
Exu Marabô das Matas — Reino das Matas
Exu Marabô do Cruzeiro — Reino dos Cruzeiros
Exu Marabô do Cabaré — Reino da Lira
Exu Marabô das Sete Encruzilhadas — Reino das Encruzilhadas
Exu Tiriri — Reino das Encruzilhadas
Exu Tiriri das Almas — Reino das Almas
Exu Tiriri da Calunga — Reino da Calunga
Exu Tiriri da Estrada — Reino das Estradas
Exu Tiriri da Praia — Reino da Praia
Exu Tiriri das Matas — Reino das Matas
Exu Tiriri da Lira — Reino da Lira
Exu Tiriri do Cruzeiro — Reino dos Cruzeiros
Exu Tiriri das Sete Portas — Reino das Encruzilhadas
Exu Tiriri das Sete Chaves — Reino dos Cruzeiros
Exu Veludo — Reino da Lira
Exu Veludo das Almas — Reino das Almas
Exu Veludo da Calunga — Reino da Calunga
Exu Veludo da Praia — Reino da Praia
Exu Veludo da Estrada — Reino das Estradas
Exu Veludo das Matas — Reino das Matas
Exu Veludo do Cruzeiro — Reino dos Cruzeiros
Exu Veludo das Sete Encruzilhadas — Reino das Encruzilhadas
Exu Veludo da Meia-Noite — Reino da Lira
Exu Veludo das Rosas — Reino da Lira
Exu Caveira — Reino da Calunga
Exu Caveira das Almas — Reino das Almas
Exu Caveira da Calunga — Reino da Calunga
Exu Caveira do Cemitério — Reino da Calunga
Exu Caveira das Sete Catacumbas — Reino da Calunga
Exu Caveira das Sete Tumbas — Reino da Calunga
Exu Caveira do Cruzeiro das Almas — Reino das Almas
Exu Caveira da Lomba — Reino da Lomba
Exu Caveira da Encruzilhada — Reino das Encruzilhadas
Exu Caveira da Estrada — Reino das Estradas
Exu Morcego — Reino da Calunga
Exu Morcego das Almas — Reino das Almas
Exu Morcego da Calunga — Reino da Calunga
Exu Morcego da Lira — Reino da Lira
Exu Morcego da Estrada — Reino das Estradas
Exu Morcego das Matas — Reino das Matas
Exu Morcego do Cruzeiro — Reino dos Cruzeiros
Exu Morcego da Praia — Reino da Praia
Exu Morcego da Meia-Noite — Reino da Lira
Exu Morcego das Sete Encruzilhadas — Reino das Encruzilhadas
Exu Sete Encruzilhadas — Reino das Encruzilhadas
Exu Sete Porteiras — Reino das Encruzilhadas
Exu Sete Portas — Reino das Encruzilhadas
Exu Sete Chaves — Reino dos Cruzeiros
Exu Sete Cruzeiros — Reino dos Cruzeiros
Exu Sete Estradas — Reino das Estradas
Exu Sete Caminhos — Reino das Estradas
Exu Sete Trilhas — Reino das Matas
Exu Sete Matas — Reino das Matas
Exu Sete Praias — Reino da Praia
Exu Gira Mundo — Reino das Estradas
Exu dos Rios — Reino da Praia
Exu do Lodo — Reino da Praia
Exu da Meia-Noite — Reino da Lira
Exu da Madrugada — Reino da Lira
Exu do Cabaré — Reino da Lira
Exu Malandro — Reino da Lira
Exu Zé Pelintra — Reino da Lira
Exu Mangueira — Reino da Lira
Exu Pimenta — Reino da Lira
Exu Pantera Negra — Reino das Matas
Exu Cobra Negra — Reino das Matas
Exu Pedra Negra — Reino das Pedreiras
Exu das Pedreiras — Reino das Pedreiras
Exu da Serra Negra — Reino das Pedreiras
Exu das Montanhas — Reino das Pedreiras
Exu da Cachoeira — Reino da Praia
Exu Ventania — Reino das Matas
Exu Folha Seca — Reino das Matas
Exu Quebra Galho — Reino das Matas
Exu Rei das Almas — Reino das Almas
Exu Rei da Calunga — Reino da Calunga
Exu Rei da Lira — Reino da Lira
Exu Rei da Praia — Reino da Praia
Exu Rei das Estradas — Reino das Estradas
Exu Rei das Matas — Reino das Matas
Exu Rei dos Cruzeiros — Reino dos Cruzeiros
Exu Rei da Lomba — Reino da Lomba
Exu Rei das Pedreiras — Reino das Pedreiras
Exu Maioral — Reino das Encruzilhadas
`
},

{
  id: "kb_pombagiras_reinos",
  title: "100 Pombagiras e seus Reinos",
  category: "pombagira",
  tags: [
    "pombagira",
    "pombo gira",
    "maria padilha",
    "maria mulambo",
    "maria quitéria",
    "rosa caveira",
    "sete saias",
    "dama da noite",
    "reinos",
    "falanges",
    "encruzilhadas",
    "calunga",
    "almas",
    "lira",
    "praia",
    "estradas",
    "cruzeiros"
  ],
  content: `
Maria Padilha Rainha das 7 Encruzilhadas — Reino das Encruzilhadas
Maria Padilha Rainha da Encruzilhada — Reino das Encruzilhadas
Maria Padilha Rainha da Calunga — Reino da Calunga
Maria Padilha Rainha do Cabaré — Reino da Lira
Maria Padilha Rainha do Cruzeiro — Reino dos Cruzeiros
Maria Padilha das Almas — Reino das Almas
Maria Padilha do Cemitério — Reino da Calunga
Maria Padilha da Praia — Reino da Praia
Maria Padilha da Estrada — Reino das Estradas
Maria Padilha das Rosas — Reino da Lira
Maria Mulambo das 7 Encruzilhadas — Reino das Encruzilhadas
Maria Mulambo da Encruzilhada — Reino das Encruzilhadas
Maria Mulambo da Calunga — Reino da Calunga
Maria Mulambo das Almas — Reino das Almas
Maria Mulambo da Praia — Reino da Praia
Maria Mulambo da Estrada — Reino das Estradas
Maria Mulambo do Cabaré — Reino da Lira
Maria Mulambo do Cruzeiro — Reino dos Cruzeiros
Maria Mulambo dos 7 Véus — Reino da Lira
Maria Mulambo dos 7 Portais — Reino das Encruzilhadas
Maria Quitéria da Encruzilhada — Reino das Encruzilhadas
Maria Quitéria da Calunga — Reino da Calunga
Maria Quitéria da Estrada — Reino das Estradas
Maria Quitéria da Praia — Reino da Praia
Maria Quitéria do Cabaré — Reino da Lira
Maria Quitéria do Cemitério — Reino da Calunga
Maria Quitéria do Cruzeiro — Reino dos Cruzeiros
Maria Quitéria dos 7 Cruzeiros — Reino dos Cruzeiros
Maria Quitéria do Porto — Reino da Praia
Maria Quitéria da Tronqueira — Reino das Encruzilhadas
Rainha das 7 Encruzilhadas — Reino das Encruzilhadas
Rainha da Encruzilhada — Reino das Encruzilhadas
Rainha da Calunga — Reino da Calunga
Rainha das Almas — Reino das Almas
Rainha da Praia — Reino da Praia
Rainha da Lira — Reino da Lira
Rainha da Lomba — Reino das Almas
Rainha do Cemitério — Reino da Calunga
Rainha do Cruzeiro das Almas — Reino das Almas
Rainha das Rosas — Reino da Lira
Rosa Caveira — Reino da Calunga
Rosa Vermelha — Reino da Lira
Sete Saias — Reino da Lira
Cigana da Estrada — Reino das Estradas
Cigana das Almas — Reino das Almas
Cigana da Praia — Reino da Praia
Dama da Noite — Reino da Lira
Pombagira das Sete Rosas — Reino da Lira
Pombagira das Sete Encruzilhadas — Reino das Encruzilhadas
Pombagira Rainha das Marias — Reino da Lira
Maria Navalha da Encruzilhada — Reino das Encruzilhadas
Maria Navalha da Calunga — Reino da Calunga
Maria Navalha da Estrada — Reino das Estradas
Maria Navalha das Almas — Reino das Almas
Maria Navalha do Cabaré — Reino da Lira
Rosa Caveira das Almas — Reino das Almas
Rosa Caveira da Calunga — Reino da Calunga
Rosa Caveira do Cruzeiro — Reino dos Cruzeiros
Rosa Caveira da Encruzilhada — Reino das Encruzilhadas
Rosa Caveira da Lomba — Reino da Lomba
Sete Saias da Encruzilhada — Reino das Encruzilhadas
Sete Saias da Lira — Reino da Lira
Sete Saias da Praia — Reino da Praia
Sete Saias da Estrada — Reino das Estradas
Sete Saias das Rosas — Reino da Lira
Dama da Noite da Encruzilhada — Reino das Encruzilhadas
Dama da Noite do Cabaré — Reino da Lira
Dama da Noite das Almas — Reino das Almas
Dama da Noite da Praia — Reino da Praia
Dama da Noite da Estrada — Reino das Estradas
Pombagira Menina da Praia — Reino da Praia
Pombagira Menina da Encruzilhada — Reino das Encruzilhadas
Pombagira Menina das Almas — Reino das Almas
Pombagira Menina da Calunga — Reino da Calunga
Pombagira Menina da Estrada — Reino das Estradas
Maria Farrapo da Calunga — Reino da Calunga
Maria Farrapo das Almas — Reino das Almas
Maria Farrapo da Encruzilhada — Reino das Encruzilhadas
Maria Farrapo da Estrada — Reino das Estradas
Maria Farrapo da Praia — Reino da Praia
Maria Rosa da Encruzilhada — Reino das Encruzilhadas
Maria Rosa das Almas — Reino das Almas
Maria Rosa da Praia — Reino da Praia
Maria Rosa do Cabaré — Reino da Lira
Maria Rosa da Calunga — Reino da Calunga
Rainha das Sete Rosas — Reino da Lira
Rainha das Sete Estradas — Reino das Estradas
Rainha dos Sete Cruzeiros — Reino dos Cruzeiros
Rainha da Meia-Noite — Reino da Lira
Rainha da Calunga Grande — Reino da Calunga
Cigana das Sete Estradas — Reino das Estradas
Cigana da Encruzilhada — Reino das Encruzilhadas
Cigana da Calunga — Reino da Calunga
Cigana das Rosas — Reino da Lira
Cigana do Oriente — Reino da Lira
Pombagira das Sete Catacumbas — Reino da Calunga
Pombagira das Sete Portas — Reino das Encruzilhadas
Pombagira das Sete Chaves — Reino dos Cruzeiros
Pombagira das Sete Tumbas — Reino da Calunga
Pombagira Rainha das Almas — Reino das Almas
`
}

];

// In-Memory & Local persistent file DB path
const DB_FILE = process.env.VERCEL
  ? "/tmp/db.json"
  : path.join(process.cwd(), "db.json");

// Load or Initialize database
function loadDb(): any {
  if (process.env.VERCEL && !fs.existsSync(DB_FILE)) {
    const bundledDbPath = path.join(process.cwd(), "db.json");
    if (fs.existsSync(bundledDbPath)) {
      try {
        fs.copyFileSync(bundledDbPath, DB_FILE);
      } catch (err) {
        console.error("Error copying db.json to /tmp:", err);
      }
    }
  }

  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    } catch (e) {
      console.error("Error reading database file, reconstructing template:", e);
    }
  }

  const initialDb = {
  users: [
    {
      id: "usr_seeker",
      email: "seeker@teste.com",
      name: "Buscador Aprendiz",
      role: "user",
      level: "Buscador",
      xp: 150,
      credits: 15,
      avatarSeed: "seeker_init",
      createdAt: new Date().toISOString()
    }
  ],
  knowledge: [...DEFAULT_KNOWLEDGE],
  logs: [
    {
      id: "log_1",
      userId: "usr_seeker",
      action: "Consulta de Oráculo - Tarot",
      details: "Arquetipo O Mago sorteado.",
      timestamp: new Date().toISOString()
    }
  ],
  messages: []
};

  fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), "utf-8");
  return initialDb;
}

// Save database assistant
function saveDb(data: any) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing database file:", e);
  }
}

type PersistedMessage = {
  id: string;
  userId: string;
  sender: "user" | "exu";
  text: string;
  timestamp: string;
};

async function persistMessages(messages: PersistedMessage[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const batch = firestore.batch();

  for (const message of messages) {
    const messageRef = firestore.collection("messages").doc(message.id);
    batch.set(messageRef, message, { merge: true });
  }

  await batch.commit();
}

async function loadUserMessages(userId: string): Promise<PersistedMessage[]> {
  const snapshot = await firestore
    .collection("messages")
    .where("userId", "==", userId)
    .limit(200)
    .get();

  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data()
    } as PersistedMessage))
    .sort(
      (a, b) =>
        new Date(a.timestamp || 0).getTime() -
        new Date(b.timestamp || 0).getTime()
    );
}

async function loadRecentUserMessages(userId: string, limitCount = 8): Promise<PersistedMessage[]> {
  try {
    const snapshot = await firestore
      .collection("messages")
      .where("userId", "==", userId)
      .limit(limitCount * 2)
      .get();

    const messages = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    } as PersistedMessage));

    messages.sort(
      (a, b) =>
        new Date(a.timestamp || 0).getTime() -
        new Date(b.timestamp || 0).getTime()
    );

    return messages.slice(-limitCount);
  } catch (err) {
    console.error("[FIRESTORE] Falha ao carregar mensagens recentes:", err);
    return [];
  }
}

async function loadKnowledgeItems(): Promise<any[]> {
  const customSnapshot = await firestore.collection("knowledge").get();
  const itemsById = new Map<string, any>();

  for (const item of DEFAULT_KNOWLEDGE) {
    itemsById.set(item.id, item);
  }

  for (const doc of customSnapshot.docs) {
    itemsById.set(doc.id, {
      id: doc.id,
      ...doc.data()
    });
  }

  return Array.from(itemsById.values());
}

async function persistLatestActivityLog(db: any): Promise<void> {
  const activityLog = Array.isArray(db?.logs) ? db.logs.at(-1) : null;

  if (!activityLog?.id) {
    return;
  }

  await firestore
    .collection("activity_logs")
    .doc(String(activityLog.id))
    .set(activityLog, { merge: true });
}

async function loadRecentActivityLogs(): Promise<any[]> {
  const snapshot = await firestore
    .collection("activity_logs")
    .orderBy("timestamp", "desc")
    .limit(200)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));
}

// Numerology Core Calculations
function calculateNumerology(name: string, dateStr: string): any {
  const sanitize = (str: string) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const cleanName = sanitize(name);

  // Chaldean/Pythagorean alphabet mapping (Standard Pythagorean)
  const letterMap: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9,
    J: 1, K: 2, L: 3, M: 4, N: 5, O: 6, P: 7, Q: 8, R: 9,
    S: 1, T: 2, U: 3, V: 4, W: 5, X: 6, Y: 7, Z: 8
  };

  const getSingleDigit = (num: number): number => {
    while (num > 9 && num !== 11 && num !== 22 && num !== 33) {
      num = num.toString().split("").reduce((acc, current) => acc + parseInt(current), 0);
    }
    return num;
  };

  // Convert numbers in date to array
  const dateNumbers = dateStr.replace(/\D/g, "").split("").map(Number);
  const dateSum = dateNumbers.reduce((a, b) => a + b, 0);
  const destinyNumber = getSingleDigit(dateSum); // Destino (Caminho da Vida)

  // Expressions and Souls
  let totalNameValue = 0;
  let vowelsValue = 0;
  let consonantsValue = 0;
  const vowels = ["A", "E", "I", "O", "U"];

  for (let char of cleanName) {
    if (letterMap[char]) {
      const val = letterMap[char];
      totalNameValue += val;
      if (vowels.includes(char)) {
        vowelsValue += val;
      } else {
        consonantsValue += val;
      }
    }
  }

  const expressionNumber = getSingleDigit(totalNameValue); // Expressão
  const soulNumber = getSingleDigit(vowelsValue); // Alma (Desejo do Coração)
  const personalityNumber = getSingleDigit(consonantsValue); // Personalidade (Aparência)

  // Karmic Lessons (Numbers missing from the name)
  const presentNumbers = new Set(cleanName.split("").map(c => letterMap[c]).filter(Boolean));
  const karmicLessons = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => !presentNumbers.has(n));

  // Personal Year Calculation (Day + Month of birth + Current Server Year)
  let personalYear = 5; // default
  const parsedDate = parseBirthDateStrict(dateStr);
  if (parsedDate.isValid) {
    const currentYear = new Date().getFullYear();
    const sum = parsedDate.day + parsedDate.month + currentYear.toString().split("").map(Number).reduce((a,b)=>a+b,0);
    personalYear = getSingleDigit(sum);
  }

  // Astrological Sign fallback computation
  let sunSign = "Aries";
  let element: "Fogo" | "Terra" | "Ar" | "Água" = "Fogo";
  let rulingPlanet = "Marte";
  let dominantHouse = 1;

  if (parsedDate.isValid) {
    const month = parsedDate.month;
    const day = parsedDate.day;

    if ((month == 3 && day >= 21) || (month == 4 && day <= 19)) {
      sunSign = "Áries"; element = "Fogo"; rulingPlanet = "Marte"; dominantHouse = 1;
    } else if ((month == 4 && day >= 20) || (month == 5 && day <= 20)) {
      sunSign = "Touro"; element = "Terra"; rulingPlanet = "Vênus"; dominantHouse = 2;
    } else if ((month == 5 && day >= 21) || (month == 6 && day <= 20)) {
      sunSign = "Gêmeos"; element = "Ar"; rulingPlanet = "Mercúrio"; dominantHouse = 3;
    } else if ((month == 6 && day >= 21) || (month == 7 && day <= 22)) {
      sunSign = "Câncer"; element = "Água"; rulingPlanet = "Lua"; dominantHouse = 4;
    } else if ((month == 7 && day >= 23) || (month == 8 && day <= 22)) {
      sunSign = "Leão"; element = "Fogo"; rulingPlanet = "Sol"; dominantHouse = 5;
    } else if ((month == 8 && day >= 23) || (month == 9 && day <= 22)) {
      sunSign = "Virgem"; element = "Terra"; rulingPlanet = "Mercúrio"; dominantHouse = 6;
    } else if ((month == 9 && day >= 23) || (month == 10 && day <= 22)) {
      sunSign = "Libra"; element = "Ar"; rulingPlanet = "Vênus"; dominantHouse = 7;
    } else if ((month == 10 && day >= 23) || (month == 11 && day <= 21)) {
      sunSign = "Escorpião"; element = "Água"; rulingPlanet = "Plutão/Marte"; dominantHouse = 8;
    } else if ((month == 11 && day >= 22) || (month == 12 && day <= 21)) {
      sunSign = "Sagitário"; element = "Fogo"; rulingPlanet = "Júpiter"; dominantHouse = 9;
    } else if ((month == 12 && day >= 22) || (month == 1 && day <= 19)) {
      sunSign = "Capricórnio"; element = "Terra"; rulingPlanet = "Saturno"; dominantHouse = 10;
    } else if ((month == 1 && day >= 20) || (month == 2 && day <= 18)) {
      sunSign = "Aquário"; element = "Ar"; rulingPlanet = "Urano"; dominantHouse = 11;
    } else {
      sunSign = "Peixes"; element = "Água"; rulingPlanet = "Netuno"; dominantHouse = 12;
    }
  }

  return {
    destinyNumber,
    soulNumber,
    expressionNumber,
    personalityNumber,
    karmicLessons,
    personalYear,
    sunSign,
    element,
    rulingPlanet,
    dominantHouse
  };
}

// Levels thresholds helper
function checkXpLevel(currentXp: number): { level: string; nextThreshold: number } {
  if (currentXp < 200) return { level: "Buscador", nextThreshold: 200 };
  if (currentXp < 500) return { level: "Aprendiz", nextThreshold: 500 };
  if (currentXp < 1200) return { level: "Peregrino", nextThreshold: 1200 };
  if (currentXp < 2500) return { level: "Iniciado", nextThreshold: 2500 };
  if (currentXp < 5000) return { level: "Guardião", nextThreshold: 5000 };
  if (currentXp < 8000) return { level: "Conhecedor", nextThreshold: 8000 };
  return { level: "Mestre dos Caminhos", nextThreshold: 999999 };
}

// Spiritual profile and symbolic affinity generator


export function calculateZodiacProfile(birthDate: string): any {
  if (!birthDate) {
    return {
      signoSolar: "Não calculado",
      elementoSigno: "Não calculado",
      planetaRegente: "Não calculado"
    };
  }

  const parts = birthDate.split("-");
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const signs = [
    { name: "Capricórnio", element: "Terra", planet: "Saturno", start: [12, 22], end: [1, 19] },
    { name: "Aquário", element: "Ar", planet: "Urano/Saturno", start: [1, 20], end: [2, 18] },
    { name: "Peixes", element: "Água", planet: "Netuno/Júpiter", start: [2, 19], end: [3, 20] },
    { name: "Áries", element: "Fogo", planet: "Marte", start: [3, 21], end: [4, 19] },
    { name: "Touro", element: "Terra", planet: "Vênus", start: [4, 20], end: [5, 20] },
    { name: "Gêmeos", element: "Ar", planet: "Mercúrio", start: [5, 21], end: [6, 20] },
    { name: "Câncer", element: "Água", planet: "Lua", start: [6, 21], end: [7, 22] },
    { name: "Leão", element: "Fogo", planet: "Sol", start: [7, 23], end: [8, 22] },
    { name: "Virgem", element: "Terra", planet: "Mercúrio", start: [8, 23], end: [9, 22] },
    { name: "Libra", element: "Ar", planet: "Vênus", start: [9, 23], end: [10, 22] },
    { name: "Escorpião", element: "Água", planet: "Plutão/Marte", start: [10, 23], end: [11, 21] },
    { name: "Sagitário", element: "Fogo", planet: "Júpiter", start: [11, 22], end: [12, 21] }
  ];

  for (const sign of signs) {
    const [sm, sd] = sign.start;
    const [em, ed] = sign.end;

    if (sm > em) {
      if ((month === sm && day >= sd) || (month === em && day <= ed)) {
        return {
          signoSolar: sign.name,
          elementoSigno: sign.element,
          planetaRegente: sign.planet
        };
      }
    } else {
      if ((month === sm && day >= sd) || (month === em && day <= ed)) {
        return {
          signoSolar: sign.name,
          elementoSigno: sign.element,
          planetaRegente: sign.planet
        };
      }
    }
  }

  return {
    signoSolar: "Não calculado",
    elementoSigno: "Não calculado",
    planetaRegente: "Não calculado"
  };
}

export function calculateSpiritualProfile(
  birthName: string,
  birthDate: string,
  birthTime?: string,
  birthPlace?: string
): any {
  if (!birthName || !birthDate) return {};

  const normalizeText = (value: string): string =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const safeIndex = (seed: string, length: number): number => {
    if (!length) return 0;

    let hash = 2166136261;

    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash +=
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }

    return Math.abs(hash >>> 0) % length;
  };

  const parsedBirth = parseBirthDateStrict(birthDate);
  const day = parsedBirth.isValid ? parsedBirth.day : 1;
  const month = parsedBirth.isValid ? parsedBirth.month : 1;
  const year = parsedBirth.isValid ? parsedBirth.year : 1900;

  const extractDigits = (value: string): string =>
    String(value || "").replace(/\D/g, "");

  const hourDigits = extractDigits(birthTime || "");
  const hour = Number(hourDigits.slice(0, 2)) || 0;
  const minute = Number(hourDigits.slice(2, 4)) || 0;

  const num = calculateNumerology(birthName, birthDate);
  const zodiac = calculateZodiacProfile(birthDate);

  const profileSeed = normalizeText(
    `${birthName}|${birthDate}|${birthTime || ""}|${birthPlace || ""}`
  );

  const odus = [
    { code: "01", name: "Òkànràn Méjì", element: "Fogo", lesson: "começos difíceis, impulso, palavra cortante e domínio emocional" },
    { code: "02", name: "Èjì Òkò", element: "Terra", lesson: "parceria, paciência, equilíbrio e construção de base" },
    { code: "03", name: "Ètà Ògúndá", element: "Fogo", lesson: "luta, corte, coragem, trabalho e conquista" },
    { code: "04", name: "Ìrosùn Méjì", element: "Terra", lesson: "ancestralidade, marcas antigas, responsabilidade e consequência" },
    { code: "05", name: "Òsé Méjì", element: "Água", lesson: "doçura, encanto, palavra, fertilidade e cuidado com vaidade" },
    { code: "06", name: "Òbàrà Méjì", element: "Fogo", lesson: "prosperidade, inteligência, comércio e poder da palavra" },
    { code: "07", name: "Òdí Méjì", element: "Terra", lesson: "proteção, limite, segredo, estratégia e disciplina" },
    { code: "08", name: "Èjì Onílè", element: "Terra", lesson: "base, território, firmeza e proteção do que é seu" },
    { code: "09", name: "Òsá Méjì", element: "Ar", lesson: "mudança, ventos fortes, força feminina e adaptação" },
    { code: "10", name: "Òfún Méjì", element: "Ar", lesson: "sabedoria, maturidade, clareza e luz ancestral" },
    { code: "11", name: "Òwónrín Méjì", element: "Ar", lesson: "instabilidade, virada rápida, movimento e adaptação" },
    { code: "12", name: "Èjìlá Ṣeborá", element: "Fogo", lesson: "justiça, força, cobrança, liderança e responsabilidade" },
    { code: "13", name: "Ìká Méjì", element: "Fogo", lesson: "conflito, discernimento diante de armadilhas, disputa e proteção" },
    { code: "14", name: "Òtúrúpòn Méjì", element: "Água", lesson: "crise profunda, renascimento, correção de caminho e cura de raiz" },
    { code: "15", name: "Òtúrá Méjì", element: "Ar", lesson: "clareza, intuição, abertura espiritual e cuidado com fantasia" },
    { code: "16", name: "Ìretè Méjì", element: "Terra", lesson: "persistência, paciência, construção lenta e resultado sólido" }
  ];

  const oduIndex =
    (day + month + year + hour + minute + safeIndex(profileSeed + "|odu", 97)) %
    odus.length;

  const selectedOdu = odus[oduIndex];

  const elementScore: Record<string, number> = {
    Fogo: 0,
    Terra: 0,
    Ar: 0,
    Água: 0
  };

  elementScore[selectedOdu.element] += 30;

  if (num.element && elementScore[num.element] !== undefined) {
    elementScore[num.element] += 25;
  }

  if (zodiac.elementoSigno && elementScore[zodiac.elementoSigno] !== undefined) {
    elementScore[zodiac.elementoSigno] += 25;
  }

  if (day >= 1 && day <= 9) elementScore.Fogo += 8;
  if (day >= 10 && day <= 18) elementScore.Terra += 8;
  if (day >= 19 && day <= 27) elementScore.Ar += 8;
  if (day >= 28) elementScore.Água += 8;

  if (hour >= 0 && hour < 6) elementScore.Água += 7;
  if (hour >= 6 && hour < 12) elementScore.Fogo += 7;
  if (hour >= 12 && hour < 18) elementScore.Ar += 7;
  if (hour >= 18) elementScore.Terra += 7;

  const elementoDominante = Object.entries(elementScore).sort((a, b) => b[1] - a[1])[0][0];

  const orixas = [
    "Exu", "Ogum", "Oxóssi", "Xangô", "Oyá", "Oxum", "Yemanjá",
    "Oxalá", "Nanã", "Obaluaê", "Ossain", "Oxumaré", "Obá", "Iroko", "Logunedé", "Ewá"
  ];

  const entidadesExu = [
    "Exu Tranca Rua", "Exu Marabô", "Exu Tiriri", "Exu Caveira",
    "Exu Veludo", "Exu Sete Encruzilhadas", "Exu Sete Caminhos",
    "Exu Odara", "Exu Lonan", "Exu Ventania", "Exu Meia-Noite",
    "Exu das Matas", "Exu da Calunga", "Exu do Cruzeiro",
    "Exu Rei das Sete Encruzilhadas", "Exu Pedra Negra",
    "Maria Padilha", "Maria Mulambo", "Maria Quitéria",
    "Pombagira Rainha", "Rosa Caveira", "Dama da Noite"
  ];

  const archetypes = [
    "Guardião de Caminhos",
    "Leitor de Sinais",
    "Abridor de Portas",
    "Estrategista da Encruzilhada",
    "Construtor de Destino",
    "Mensageiro de Movimento",
    "Curador de Raiz",
    "Observador do Invisível",
    "Condutor de Recomeços",
    "Senhor da Palavra",
    "Alma de Travessia",
    "Força de Transformação"
  ];

  const orixaAfinidade = orixas[safeIndex(profileSeed + "|orixa|" + elementoDominante, orixas.length)];

  const exuAfinidade = entidadesExu[safeIndex(profileSeed + "|exu|" + selectedOdu.name, entidadesExu.length)];

  const arquetipoDominante = archetypes[safeIndex(profileSeed + "|arquetipo|" + zodiac.signoSolar, archetypes.length)];

  const assinaturaEnergetica = `AXE-${safeIndex(profileSeed + "|assinatura", 99999)
    .toString()
    .padStart(5, "0")}-${num.destinyNumber || 7}`;

  const baseFogo = Math.min(95, Math.max(15, elementScore.Fogo + safeIndex(profileSeed + "|fogo", 18)));
  const baseTerra = Math.min(95, Math.max(15, elementScore.Terra + safeIndex(profileSeed + "|terra", 18)));
  const baseAr = Math.min(95, Math.max(15, elementScore.Ar + safeIndex(profileSeed + "|ar", 18)));
  const baseAgua = Math.min(95, Math.max(15, elementScore.Água + safeIndex(profileSeed + "|agua", 18)));

  return {
    oduPrincipal: selectedOdu.name,
    oduNumero: selectedOdu.code,
    oduTipo: "afinidade espiritual calculada por nome, data, hora e local; não substitui jogo real de Ifá",
    oduElemento: selectedOdu.element,
    oduLicao: selectedOdu.lesson,

    signoSolar: zodiac.signoSolar,
    elementoSigno: zodiac.elementoSigno,
    planetaRegente: zodiac.planetaRegente,

    elementoDominante,
    elementoNumerologico: num.element || "Não calculado",

    orixaAfinidade,
    exuAfinidade,
    arquetipoDominante,
    assinaturaEnergetica,

    mapaVibracional: {
      Fogo: baseFogo,
      Terra: baseTerra,
      Ar: baseAr,
      Agua: baseAgua
    },

    destinyNumber: num.destinyNumber,
    soulNumber: num.soulNumber,
    expressionNumber: num.expressionNumber,
    personalYear: num.personalYear
  };
}

export function formatSpiritualProfileForPrompt(user: any): string {
  return `
PERFIL ESPIRITUAL DO CONSULENTE:

- Nome social: ${user.name || "Consulente"}
- Nome de nascimento/registro: ${user.birthName || user.name || "Não informado"}
- Data de nascimento: ${user.birthDate || "Não informada"}
- Hora de nascimento: ${user.birthTime || "Não informada"}

MAPA CALCULADO PELO SISTEMA:

- Signo solar: ${user.signoSolar || user.signo || "Não calculado"}
- Elemento astrológico: ${user.elementoSigno || user.elementoAstrologico || "Não calculado"}
- Planeta regente: ${user.planetaRegente || "Não calculado"}
- Odù de afinidade: ${user.oduPrincipal || "Não calculado"}
- Tipo de Odù: ${user.oduTipo || "afinidade espiritual calculada, não jogo presencial de Ifá"}
- Orixá de afinidade: ${user.orixaAfinidade || "Não calculado"}
- Exu de afinidade: ${user.exuAfinidade || "Não calculado"}
- Arquétipo dominante: ${user.arquetipoDominante || "Não calculado"}
- Assinatura energética: ${user.assinaturaEnergetica || "Não calculada"}

FUNDAMENTOS NUMEROLÓGICOS:

- Número de destino: ${user.destinyNumber !== undefined ? user.destinyNumber : "Não calculado"}
- Número da alma: ${user.soulNumber !== undefined ? user.soulNumber : "Não calculado"}
- Número de expressão: ${user.expressionNumber !== undefined ? user.expressionNumber : "Não calculado"}
- Ano pessoal: ${user.personalYear !== undefined ? user.personalYear : "Não calculado"}

MAPA ELEMENTAL:

- Fogo: ${user.mapaVibracional?.Fogo || 0}%
- Terra: ${user.mapaVibracional?.Terra || 0}%
- Ar: ${user.mapaVibracional?.Ar || 0}%
- Água: ${user.mapaVibracional?.Agua || 0}%
`;
}

function generateDeterministicInitialReading(user: any): string {
  const name = user.birthName || user.name || "Consulente";
  const odu = user.oduPrincipal || "Odù de afinidade ancestral não calculado";
  const oduLesson = user.oduLicao || "escolha, responsabilidade e movimento";
  const orixa = user.orixaAfinidade || "Orixá de afinidade não calculado";
  const exu = user.exuAfinidade || "Exu de afinidade não calculado";
  const archetype = user.arquetipoDominante || "Buscador de Caminhos";
  const sign = user.signoSolar || "Signo não calculado";
  const signElement = user.elementoSigno || "Elemento não calculado";
  const dominantElement = user.elementoDominante || "Elemento dominante não calculado";
  const planet = user.planetaRegente || "Planeta não calculado";
  const dNum = user.destinyNumber || "Não calculado";
  const sNum = user.soulNumber || "Não calculado";
  const eNum = user.expressionNumber || "Não calculado";
  const pYear = user.personalYear || "Não calculado";

  return `# 🔱 LEITURA INICIAL DO REINO DE EXU

**Consulente:** ${name}

Esta leitura foi formada pelos dados do seu cadastro: nome de nascimento, data, hora e local informados.

---

## 1. Sua chave principal

O Odù que se apresenta como de afinidade é **${odu}**.

Ele fala de **${oduLesson}**.

---

## 2. Sua força espiritual de afinidade

Seu Orixá de afinidade é **${orixa}**.

Seu Exu de afinidade é **${exu}**.

Seu arquétipo dominante é **${archetype}**.

---

## 3. Sua marca astrológica

Seu signo solar é **${sign}**.

O elemento do seu signo é **${signElement}**.

O planeta regente associado é **${planet}**.

---

## 4. Seu mapa numerológico

Número de destino: **${dNum}**  
Número da alma: **${sNum}**  
Número de expressão: **${eNum}**  
Ano pessoal: **${pYear}**

---

## 5. Elemento dominante

Seu elemento dominante calculado é **${dominantElement}**.

Quando esse elemento está equilibrado, ele vira força.

Quando está desordenado, ele vira armadilha.

---

## 6. Palavra de Exu

O sinal principal da sua leitura não é para esperar milagre.

É para entender padrão.

Exu não entrega caminho para quem se recusa a andar.

Mas quando a pessoa enxerga a própria chave, a porta deixa de parecer parede.

---

**Orientação prática:** observe onde você repete as mesmas escolhas esperando resultados diferentes.`;
}

// ----------------------------------------
// Express Router API Setups
// ----------------------------------------


// Auth API - Register
app.post(
  "/api/auth/register",
  requireFirebaseAuth,
  async (req, res) => {
    const parseResult = registerBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: parseResult.error.issues[0]?.message || "Dados de cadastro inválidos."
      });
    }

    const {
      birthName,
      birthDate,
      birthTime,
      birthPlace,
      email,
      deviceId,
      browser,
      session,
      honeypot,
      termsAccepted,
      privacyAccepted,
      termsVersion,
      privacyVersion
    } = parseResult.data;

    const firebaseUser = (req as any).firebaseUser as DecodedIdToken;

    const firebaseEmail =
      typeof firebaseUser?.email === "string"
        ? firebaseUser.email.trim().toLowerCase()
        : "";

    const submittedEmail =
      typeof email === "string"
        ? email.trim().toLowerCase()
        : "";

    if (!firebaseUser?.uid || !firebaseEmail) {
      return res.status(401).json({
        error: "A identidade Firebase deste cadastro não pôde ser validada."
      });
    }

    if (honeypot) {
      return res.status(400).json({
        error:
          "Atividade de automação suspeita detectada (Honeypot). Cadastro bloqueado."
      });
    }

    // Identificação de IP e Rate Limiting Durável
    const clientIp = getClientIp(req);

    if (!await checkDurableRateLimit(`reg_${clientIp}`, 5, 15 * 60 * 1000)) {
      return res.status(429).json({
        error:
          "Muitas tentativas de cadastro a partir deste endereço. Por favor, aguarde 15 minutos."
      });
    }

    const placeToUseSubmit = birthPlace ? birthPlace.trim() : "";

    if (submittedEmail !== firebaseEmail) {
      return res.status(403).json({
        error:
          "O e-mail informado não corresponde à identidade autenticada no Firebase."
      });
    }

    const normalizedEmail = email.toLowerCase();
    const normalizedDeviceId = deviceId || "dev_not_tracked";

    // Verifica e-mail no Firestore
    const emailSnapshot = await firestore
      .collection("users")
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();

    if (!emailSnapshot.empty) {
      return res.status(400).json({ error: "Este email já está cadastrado em nosso portal." });
    }

    // Verifica dispositivo no Firestore
    let hasDeviceMatch = false;
    if (normalizedDeviceId !== "dev_not_tracked") {
      const deviceSnapshot = await firestore
        .collection("users")
        .where("deviceId", "==", normalizedDeviceId)
        .limit(1)
        .get();

      hasDeviceMatch = !deviceSnapshot.empty;
    }

    // Verifica IP no Firestore (sem limit(1) para contar contas recentes com precisão)
    const ipSnapshot = await firestore
      .collection("users")
      .where("ip", "==", clientIp)
      .get();

    const hasIpMatch = !ipSnapshot.empty;
    const ipUsers = ipSnapshot.docs.map(doc => doc.data());

    const hasSameIpBrowser = ipUsers.some((u: any) =>
      u.browser === (browser || "unknown")
    );

    const hasSameIpSession = ipUsers.some((u: any) =>
      u.sessionSign === (session || "unknown")
    );

    const recentIpAccounts = ipUsers.filter((u: any) => {
      const created = new Date(u.createdAt || 0).getTime();
      return created && Date.now() - created < 24 * 60 * 60 * 1000;
    });

    const tooManyRecentIpAccounts = recentIpAccounts.length >= 2;

    const fraudReasons: string[] = [];

    if (!deviceId || normalizedDeviceId === "dev_not_tracked") {
      fraudReasons.push("missing_device_id");
    }

    if (hasIpMatch) fraudReasons.push("ip_already_used");
    if (hasDeviceMatch) fraudReasons.push("device_already_used");
    if (hasSameIpBrowser) fraudReasons.push("same_ip_and_browser");
    if (hasSameIpSession) fraudReasons.push("same_ip_and_session");
    if (tooManyRecentIpAccounts) fraudReasons.push("too_many_recent_accounts_same_ip");

    const creditsBlocked = fraudReasons.length > 0;
    const isEmailVerified = Boolean(firebaseUser.email_verified);

    // REGRA DE SEGURANÇA: ZERO créditos utilizáveis e ZERO chamadas de IA antes do e-mail verificado!
    const initialCredits = isEmailVerified && !creditsBlocked ? 5 : 0;

    // Generate spiritual details
    const spiritualProps = calculateSpiritualProfile(birthName, birthDate, birthTime, placeToUseSubmit);
    const cleanFirstName = birthName.split(" ")[0];

    const newUser = {
      id: "usr_" + Math.random().toString(36).substring(2, 11),
      firebaseUid: firebaseUser.uid,
      email: normalizedEmail,
      name:
        cleanFirstName.charAt(0).toUpperCase() +
        cleanFirstName.slice(1).toLowerCase(),
      birthName,
      birthDate,
      birthTime: birthTime || "",
      birthPlace: placeToUseSubmit,
      role: "user",
      level: "Buscador",
      xp: 0,
      credits: initialCredits,
      promotionalCreditsBlocked: creditsBlocked,
      avatarSeed:
        "eleg_seed_" + Math.floor(Math.random() * 9999),
      createdAt: new Date().toISOString(),
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: termsVersion || "1.0",
      privacyVersion: privacyVersion || "1.0",
      legalConsentAt: new Date().toISOString(),
      ip: clientIp,
      deviceId: deviceId || "dev_not_tracked",
      browser: browser || "unknown",
      sessionSign: session || "unknown",
      emailVerified: isEmailVerified,
      ...spiritualProps
    };

    await firestore
      .collection("users")
      .doc(newUser.id)
      .set({
        ...newUser,
        createdAt: new Date().toISOString(),
        fraudReasons
      });

    // Auditoria legal persistida (LGPD)
    await firestore
      .collection("legal_consents")
      .doc("consent_" + newUser.id)
      .set({
        userId: newUser.id,
        firebaseUid: firebaseUser.uid,
        email: normalizedEmail,
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: termsVersion || "1.0",
        privacyVersion: privacyVersion || "1.0",
        age18Confirmed: true,
        acceptedAt: new Date().toISOString(),
        ipHash: crypto.createHash("sha256").update(clientIp + "consent_salt").digest("hex").substring(0, 16),
        userAgent: browser || "unknown"
      });

    // Se créditos promocionais foram concedidos imediatamente (ex: e-mail já veio verificado), registrar no Ledger
    if (initialCredits > 0) {
      await firestore
        .collection("credit_ledger")
        .doc("op_reg_" + newUser.id)
        .set({
          operationId: "op_reg_" + newUser.id,
          userId: newUser.id,
          firebaseUid: firebaseUser.uid,
          type: "grant",
          amount: initialCredits,
          balanceBefore: 0,
          balanceAfter: initialCredits,
          status: "committed",
          source: "registration",
          reason: "Boas-vindas ao terreiro (crédito promocional de abertura)",
          createdAt: new Date().toISOString()
        });
    }

    await firestore.collection("security_logs").add({
      type: "register_attempt",
      userId: newUser.id,
      email: normalizedEmail,
      ip: clientIp,
      deviceId: normalizedDeviceId,
      browser: browser || "unknown",
      sessionSign: session || "unknown",
      creditsGranted: initialCredits,
      promotionalCreditsBlocked: creditsBlocked,
      emailVerified: isEmailVerified,
      fraudReasons,
      createdAt: new Date().toISOString()
    });

    // REGRA DE SEGURANÇA: NÃO chamar Gemini se o e-mail não estiver verificado!
    // Para contas não verificadas, gera leitura determinística dos fundamentos sem custo de IA.
    let readingReport = "";
    if (isEmailVerified) {
      try {
        const prompt = `Como o oráculo de luz místico EXU RESPONDE, gere uma Leitura Inicial Completa para o consultante ${newUser.name}. 
O tom deve ser solene, prestigioso, estratégico, sutil e carregado com português tradicional de terreiro.

Dados sagrados do peregrino:
- Nome Completo de Solteiro: ${newUser.birthName}
- Data de Nascimento: ${newUser.birthDate}
- Horário de Nascimento: ${newUser.birthTime || "Não informado"}

Você DEVE estruturar o relatório obrigatoriamente utilizando Markdown com as seguintes seções bem delimitadas:

### PERFIL ESPIRITUAL
- Odu principal (calculado: ${newUser.oduPrincipal})
- Odu complementar (calculado: Eji Ogbe)
- Orixá de afinidade (calculado: ${newUser.orixaAfinidade})
- Exu de afinidade (calculado: ${newUser.exuAfinidade})
- Arquétipo predominante (calculado: ${newUser.arquetipoDominante})
- Assinatura energética: ${newUser.assinaturaEnergetica}

### PERFIL NUMEROLÓGICO
- Número de destino: ${newUser.destinyNumber}
- Número da alma: ${newUser.soulNumber}
- Número de expressão: ${newUser.expressionNumber}
- Ano pessoal (calendário ${new Date().getFullYear()}): ${newUser.personalYear}

### PERFIL ASTROLÓGICO
- Signo solar: ${newUser.signoSolar || "Áries"}
- Influências planetárias dominantes

### RESUMO DOS DESTINOS
- Quem é a pessoa e seus caminhos
- Conselhos reflexivos e pragmáticos de Exu`;

        const geminiResult = await generateWithGeminiFallback({
          contents: prompt,
          systemInstruction:
            "Você é Exu falando no Exu Responde. Responda com dignidade tradicional de terreiro e sabedoria prática.",
        });

        readingReport = fixPortugueseEncoding(geminiResult.text);
      } catch (err) {
        console.error("Gemini no cadastro falhou, usando leitura determinística:", err);
      }
    }

    if (!readingReport) {
      readingReport = generateDeterministicInitialReading(newUser);
    }

    // Salva Leitura Inicial no Firestore
    const initialReadingId = "msg_init_read_" + Date.now();
    const initialReadingMessage: PersistedMessage = {
      id: initialReadingId,
      userId: newUser.id,
      sender: "exu",
      text: readingReport,
      timestamp: new Date().toISOString()
    };

    const firstConversationStarterId = "msg_opener_" + (Date.now() + 1);
    const firstConversationMessage: PersistedMessage = {
      id: firstConversationStarterId,
      userId: newUser.id,
      sender: "exu",
      text: isEmailVerified
        ? "Salve sua banda, filho de fé. Já observei os caminhos apresentados pelos dados que me confiou. Em que posso ajudar?"
        : "Salve sua banda, filho de fé. Seu cadastro foi recebido. Confirme seu e-mail para despertar seu saldo de Axé e consultar os oráculos.",
      timestamp: new Date().toISOString()
    };

    await persistMessages([initialReadingMessage, firstConversationMessage]);

    return res.json({
      success: true,
      user: toPublicUserDTO(newUser.id, newUser),
      requiresEmailVerification: !isEmailVerified
    });
  }
);




// Auth API - Login
app.post(
  "/api/auth/login",
  requireFirebaseAuth,
  async (req, res) => {
    const firebaseUser =
      (req as any).firebaseUser as DecodedIdToken;

    const firebaseEmail =
      typeof firebaseUser?.email === "string"
        ? firebaseUser.email.trim().toLowerCase()
        : "";

    if (!firebaseUser?.uid || !firebaseEmail) {
      return res.status(401).json({
        error: "A identidade Firebase não pôde ser validada."
      });
    }

    const clientIp = getClientIp(req);

    if (!await checkDurableRateLimit(`login_${clientIp}`, 15, 15 * 60 * 1000)) {
      return res.status(429).json({
        error: "Muitas tentativas de login recentes. Por favor, aguarde alguns minutos."
      });
    }

    if (!firebaseUser.email_verified) {
      return res.status(403).json({
        error:
          "Confirme seu e-mail antes de entrar no portal."
      });
    }

    const submittedEmail =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    if (
      submittedEmail &&
      submittedEmail !== firebaseEmail
    ) {
      return res.status(403).json({
        error:
          "O e-mail informado não corresponde à sessão autenticada."
      });
    }

    // Busca usuário primariamente por firebaseUid, depois por email
    let snapshot = await firestore
      .collection("users")
      .where("firebaseUid", "==", firebaseUser.uid)
      .limit(1)
      .get();

    if (snapshot.empty) {
      snapshot = await firestore
        .collection("users")
        .where("email", "==", firebaseEmail)
        .limit(1)
        .get();
    }

    if (snapshot.empty) {
      return res.status(404).json({
        error:
          "Este buscador não está cadastrado no portal."
      });
    }

    const doc = snapshot.docs[0];
    const userData = doc.data() as any;

    if (userData.isBlocked) {
      return res.status(403).json({
        error: "Este perfil foi suspenso por medidas de segurança do terreiro."
      });
    }

    if (userData.firebaseUid && userData.firebaseUid !== firebaseUser.uid) {
      return res.status(403).json({
        error:
          "Esta conta está vinculada a outra identidade Firebase."
      });
    }

    // Ativação de créditos promocionais se foi recém-verificado
    let creditsToUpdate = Number(userData.credits || 0);
    const wasUnverified = !userData.emailVerified;

    if (
      wasUnverified &&
      !userData.promotionalCreditsBlocked &&
      creditsToUpdate === 0
    ) {
      creditsToUpdate = 5;
      await firestore
        .collection("credit_ledger")
        .doc("op_grant_verify_" + doc.id)
        .set({
          operationId: "op_grant_verify_" + doc.id,
          userId: doc.id,
          firebaseUid: firebaseUser.uid,
          type: "grant",
          amount: 5,
          balanceBefore: 0,
          balanceAfter: 5,
          status: "committed",
          source: "registration",
          reason: "Créditos promocionais concedidos após confirmação do e-mail",
          createdAt: new Date().toISOString()
        });
    }

    await doc.ref.set(
      {
        firebaseUid: firebaseUser.uid,
        emailVerified: true,
        credits: creditsToUpdate,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );

    const refreshedDoc = await doc.ref.get();

    return res.json({
      success: true,
      user: toPublicUserDTO(refreshedDoc.id, refreshedDoc.data() || {})
    });
  }
);





// Auth API - Password Reset / Forgot Password
app.post(
  ["/api/auth/reset-password", "/api/auth/forgot-password"],
  async (req, res) => {
    const clientIp = getClientIp(req);

    if (!await checkDurableRateLimit(`pwd_reset_${clientIp}`, 5, 15 * 60 * 1000)) {
      return res.status(429).json({
        error: "Muitas tentativas de recuperação de senha. Por favor, aguarde 15 minutos."
      });
    }

    const { email } = req.body;
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Informe um endereço de e-mail válido." });
    }

    try {
      if (firebaseAuth && typeof (firebaseAuth as any).generatePasswordResetLink === "function") {
        await (firebaseAuth as any).generatePasswordResetLink(email.trim().toLowerCase());
      }
    } catch (_e) {
      // Silencia detalhes do erro para evitar enumeração de contas
    }

    return res.json({
      success: true,
      message: "Se o e-mail estiver cadastrado em nosso portal, o link de recuperação foi enviado."
    });
  }
);

// Load Current Profile
app.get(
  "/api/user/profile",
  requireFirebaseAuth,
  async (req, res) => {
    const firebaseUser =
      (req as any).firebaseUser as DecodedIdToken;

    const firebaseEmail =
      typeof firebaseUser?.email === "string"
        ? firebaseUser.email.trim().toLowerCase()
        : "";

    if (!firebaseUser?.uid || !firebaseEmail) {
      return res.status(401).json({
        error: "A identidade Firebase não pôde ser validada."
      });
    }

    // Primeiro procura pelo vínculo seguro com Firebase UID
    let snapshot = await firestore
      .collection("users")
      .where("firebaseUid", "==", firebaseUser.uid)
      .limit(1)
      .get();

    // Compatibilidade com contas antigas ainda não migradas
    if (snapshot.empty) {
      snapshot = await firestore
        .collection("users")
        .where("email", "==", firebaseEmail)
        .limit(1)
        .get();
    }

    if (snapshot.empty) {
      return res.status(404).json({
        error: "Buscador não encontrado."
      });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data() as any;

    if (
      userData.firebaseUid &&
      userData.firebaseUid !== firebaseUser.uid
    ) {
      return res.status(403).json({
        error:
          "Esta conta está vinculada a outra identidade Firebase."
      });
    }

    // Migra conta antiga para o Firebase UID atual
    if (!userData.firebaseUid) {
      await userDoc.ref.set(
        {
          firebaseUid: firebaseUser.uid,
          emailVerified: Boolean(firebaseUser.email_verified),
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
    }

    const chats = await loadUserMessages(userDoc.id);

    const refreshedUserDoc =
      await userDoc.ref.get();

    return res.json({
      user: toPublicUserDTO(refreshedUserDoc.id, refreshedUserDoc.data() || {}),
      chats
    });
  }
);




// Update Birth details
app.post(
  "/api/user/update",
  requireFirebaseAuth,
  async (req, res) => {
    const parseResult = userUpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: parseResult.error.issues[0]?.message || "Dados de atualização inválidos."
      });
    }

    const firebaseUser =
      (req as any).firebaseUser as DecodedIdToken;

    const {
      birthName,
      birthDate,
      birthTime,
      birthPlace,
      name
    } = parseResult.data;

    if (!firebaseUser?.uid) {
      return res.status(401).json({
        error: "Sessão Firebase inválida."
      });
    }

    let snapshot = await firestore
      .collection("users")
      .where("firebaseUid", "==", firebaseUser.uid)
      .limit(1)
      .get();

    // Compatibilidade com contas antigas
    if (
      snapshot.empty &&
      typeof firebaseUser.email === "string"
    ) {
      snapshot = await firestore
        .collection("users")
        .where(
          "email",
          "==",
          firebaseUser.email.trim().toLowerCase()
        )
        .limit(1)
        .get();
    }

    if (snapshot.empty) {
      return res.status(404).json({
        error: "Usuário não encontrado."
      });
    }

    const userDocRef = snapshot.docs[0].ref;
    const userDoc = await userDocRef.get();

    const currentUser = {
      id: userDoc.id,
      ...userDoc.data()
    } as any;

    if (
      currentUser.firebaseUid &&
      currentUser.firebaseUid !== firebaseUser.uid
    ) {
      return res.status(403).json({
        error:
          "Esta conta está vinculada a outra identidade Firebase."
      });
    }

    const nameToUse = (name ? name.trim() : (currentUser.name || "")).substring(0, 100);
    const birthNameToUse = birthName !== undefined ? birthName.trim() : (currentUser.birthName || nameToUse);
    const birthDateToUse = birthDate !== undefined ? birthDate.trim() : (currentUser.birthDate || "");
    const birthTimeToUse = birthTime !== undefined ? birthTime.trim() : (currentUser.birthTime || "");
    const birthPlaceToUse = birthPlace !== undefined ? birthPlace.trim() : (currentUser.birthPlace || "");

    const natalChanged =
      birthNameToUse !== (currentUser.birthName || "") ||
      birthDateToUse !== (currentUser.birthDate || "") ||
      birthTimeToUse !== (currentUser.birthTime || "") ||
      birthPlaceToUse !== (currentUser.birthPlace || "");

    let spiritualProps = {};
    if (natalChanged && birthNameToUse && birthDateToUse) {
      spiritualProps = calculateSpiritualProfile(
        birthNameToUse,
        birthDateToUse,
        birthTimeToUse,
        birthPlaceToUse
      );
    }

    const updatedUser = {
      ...currentUser,
      firebaseUid: firebaseUser.uid,
      name: nameToUse || currentUser.name,
      birthName: birthNameToUse,
      birthDate: birthDateToUse,
      birthTime: birthTimeToUse,
      birthPlace: birthPlaceToUse,
      ...spiritualProps,
      updatedAt: new Date().toISOString()
    };

    await userDocRef.set(
      updatedUser,
      { merge: true }
    );

    await firestore.collection("activity_logs").add({
      userId: userDoc.id,
      action: "Atualização de Identidade",
      details:
        "Recálculo do perfil astrológico e numerológico ancestral concluído com sucesso.",
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      user: toPublicUserDTO(userDoc.id, updatedUser)
    });
  }
);





type TarotCard = {
  id: string;
  arcano: "maior" | "menor";
  numero?: number;
  nome: string;
  grupo?: "paus" | "copas" | "espadas" | "ouros";
  entidade?: string;
  traducao: string;
  normal: string;
};

const TAROT_MARSEILLE_78: TarotCard[] = [
  // ARCANOS MAIORES
  {
    id: "maior_01_mago",
    arcano: "maior",
    numero: 1,
    nome: "O Mago",
    entidade: "Exu e Crianças",
    traducao: "A pessoa é criativa, comunicativa, tem iniciativa, força de vontade, fé e sabedoria. Carta positiva e de incentivo, mas alerta para a lei do retorno: tudo que se planta, colhe.",
    normal: "Inteligência, vontade, iniciativa e atividade mental consciente."
  },
  {
    id: "maior_02_papisa",
    arcano: "maior",
    numero: 2,
    nome: "A Papisa",
    entidade: "Iemanjá",
    traducao: "Fala da mulher intuitiva, sensível e de grande força. Representa reflexão, energia interna, segredo, mistério, silêncio, memória, intuição e sabedoria.",
    normal: "Intuição, sabedoria, mistério e força interior."
  },
  {
    id: "maior_03_imperatriz",
    arcano: "maior",
    numero: 3,
    nome: "A Imperatriz",
    entidade: "Oxum",
    traducao: "Representa o poder da imaginação, a visualização criativa, as belas emoções e o amor.",
    normal: "Materialização do desejo."
  },
  {
    id: "maior_04_imperador",
    arcano: "maior",
    numero: 4,
    nome: "O Imperador",
    entidade: "Ogum",
    traducao: "Representa poder, autoridade, razão, lógica, raciocínio, comando, determinação e vontade de tomar as rédeas da própria vida.",
    normal: "Atividade, força, poder, comando e justiça."
  },
  {
    id: "maior_05_papa",
    arcano: "maior",
    numero: 5,
    nome: "O Papa",
    entidade: "Oxalá e Oxalufã",
    traducao: "Representa o professor, o inspirador, o conhecimento aplicado, o guia interior, o mestre espiritual e a ligação com pessoa sábia, calma e espiritualizada.",
    normal: "Conhecimento, amadurecimento e superação."
  },
  {
    id: "maior_06_namorados",
    arcano: "maior",
    numero: 6,
    nome: "Os Namorados",
    entidade: "Erês",
    traducao: "Representa amor, paixão, dúvidas, retorno de alguém, sinceridade consigo mesmo e escolha do coração.",
    normal: "Uniões, amor e situações felizes."
  },
  {
    id: "maior_07_carro",
    arcano: "maior",
    numero: 7,
    nome: "O Carro",
    entidade: "Ogum e Iemanjá",
    traducao: "Fala de busca interna e externa, disputas vencidas, vitória, sucesso, inteligência emocional e ação.",
    normal: "Sucesso em conflitos, vitória e avanço."
  },
  {
    id: "maior_08_justica",
    arcano: "maior",
    numero: 8,
    nome: "A Justiça",
    entidade: "Xangô",
    traducao: "Plante coisas boas e colherá coisas boas. Equilíbrio entre bem e mal, ação justa e calma diante das circunstâncias.",
    normal: "Justiça a favor, equilíbrio e colheita."
  },
  {
    id: "maior_09_ermitao",
    arcano: "maior",
    numero: 9,
    nome: "O Ermitão",
    entidade: "Ifá",
    traducao: "Representa reflexão, meditação, prudência, isolamento, quebra de ilusões e revelação da realidade verdadeira.",
    normal: "Organização, verdade, prudência e clareza."
  },
  {
    id: "maior_10_roda_fortuna",
    arcano: "maior",
    numero: 10,
    nome: "Roda da Fortuna",
    entidade: "Iansã",
    traducao: "Fortuna, abundância, alegria de viver, bons frutos, progresso, sucesso, mudanças e movimentos de boa sorte.",
    normal: "Boa fortuna, sincronia e movimento favorável."
  },
  {
    id: "maior_11_forca",
    arcano: "maior",
    numero: 11,
    nome: "A Força",
    entidade: "Iniciação",
    traducao: "Representa energia interna, energia sexual, instintos, impulso, magia e necessidade de estudo.",
    normal: "Força interior, domínio dos impulsos e magnetismo."
  },
  {
    id: "maior_12_enforcado",
    arcano: "maior",
    numero: 12,
    nome: "O Enforcado",
    traducao: "Trabalho em prol de uma causa, abnegação, resgate, sacrifício para despertar espiritual e desapego do que prejudica o progresso.",
    normal: "Renúncia, pausa, sacrifício e libertação de prisão."
  },
  {
    id: "maior_13_morte",
    arcano: "maior",
    numero: 13,
    nome: "A Morte",
    entidade: "Omolu",
    traducao: "Transformação, mudanças, libertação de restrições, fim de ciclo e início de outro. Algo que atrapalhava deixa de atrapalhar.",
    normal: "Fim, transformação e recomeço."
  },
  {
    id: "maior_14_temperanca",
    arcano: "maior",
    numero: 14,
    nome: "A Temperança",
    entidade: "Xangô",
    traducao: "Equilíbrio interior, guia interno, voz que pede equilíbrio, cura, sucesso e mudança positiva.",
    normal: "Equilíbrio, cura e harmonia."
  },
  {
    id: "maior_15_diabo",
    arcano: "maior",
    numero: 15,
    nome: "O Diabo",
    entidade: "Exu",
    traducao: "Magnetismo pessoal, poder de sedução, fome de sexo, poder, política, jogo de cintura, desejo de manipular, apego, prazer, sexualidade e erotismo.",
    normal: "Sedução, desejo, magnetismo, poder e apego."
  },
  {
    id: "maior_16_torre",
    arcano: "maior",
    numero: 16,
    nome: "A Torre",
    traducao: "Lutas, discórdias, necessidade de eliminar o errado, destruição do orgulho e do ego, recomeço e libertação das armadilhas do passado.",
    normal: "Queda do ego, ruptura, libertação e recomeço."
  },
  {
    id: "maior_17_estrela",
    arcano: "maior",
    numero: 17,
    nome: "A Estrela",
    entidade: "Iemanjá",
    traducao: "Esperança, capacidade de doar, acreditar em algo melhor, amor e fé.",
    normal: "Carta ótima, esperança, amor e fé."
  },
  {
    id: "maior_18_lua",
    arcano: "maior",
    numero: 18,
    nome: "A Lua",
    traducao: "Mistério, fascinação, sonhos, ilusões, lado criativo e sombrio da mente, subconsciente, feitiçamentos e demanda.",
    normal: "Mistério, ilusão, sonho e força do subconsciente."
  },
  {
    id: "maior_19_sol",
    arcano: "maior",
    numero: 19,
    nome: "O Sol",
    traducao: "Boa sorte, luz, destino favorecido, bênção grandiosa, sucesso, portas abertas, bons acontecimentos e felicidade.",
    normal: "Sucesso, luz, alegria e bênção."
  },
  {
    id: "maior_20_julgamento",
    arcano: "maior",
    numero: 20,
    nome: "O Julgamento",
    entidade: "Nanã",
    traducao: "Reconstruir, redirecionar, assumir novo padrão de comportamento e receber nova oportunidade.",
    normal: "Nova oportunidade, chamado e renascimento."
  },
  {
    id: "maior_21_mundo",
    arcano: "maior",
    numero: 21,
    nome: "O Mundo",
    traducao: "Poderes paranormais, domínio sobre leis físicas e matéria, planeta Saturno, cor azul violeta, sucesso e domínio das situações.",
    normal: "Sucesso, domínio e realização."
  },
  {
    id: "maior_22_cometa",
    arcano: "maior",
    numero: 22,
    nome: "O Cometa",
    traducao: "Sucesso, superação, êxtase, poder sobre a própria vida, alinhamento, sabedoria e equilíbrio acima de tudo.",
    normal: "Carta ótima, superação e alinhamento."
  },

  // PAUS
  { id: "paus_rei", arcano: "menor", grupo: "paus", nome: "Rei de Paus", traducao: "Representa a ação possível.", normal: "Homem respeitável e amigável." },
  { id: "paus_rainha", arcano: "menor", grupo: "paus", nome: "Rainha de Paus", traducao: "Representa a ação desejável.", normal: "Mulher atraente e inteligente." },
  { id: "paus_cavaleiro", arcano: "menor", grupo: "paus", nome: "Cavaleiro de Paus", traducao: "Representa a ação necessária.", normal: "Troca de residência." },
  { id: "paus_valete", arcano: "menor", grupo: "paus", nome: "Valete de Paus", traducao: "Representa ação imediata.", normal: "Chegada de boas notícias." },
  { id: "paus_10", arcano: "menor", grupo: "paus", numero: 10, nome: "Dez de Paus", traducao: "Situações opressivas e opressão que chega ao limite.", normal: "Opressão." },
  { id: "paus_09", arcano: "menor", grupo: "paus", numero: 9, nome: "Nove de Paus", traducao: "Poder da informação e força física ou psíquica.", normal: "Conhecimentos especiais." },
  { id: "paus_08", arcano: "menor", grupo: "paus", numero: 8, nome: "Oito de Paus", traducao: "Imprevisto, percepção dos sentimentos de outras pessoas e rapidez de ação.", normal: "Notícias imprevistas e rapidez." },
  { id: "paus_07", arcano: "menor", grupo: "paus", numero: 7, nome: "Sete de Paus", traducao: "Valor, prazer em riscos e atividades perigosas que resultam em estímulo.", normal: "Atividades arriscadas." },
  { id: "paus_06", arcano: "menor", grupo: "paus", numero: 6, nome: "Seis de Paus", traducao: "Esforços compensados e vitórias depois de lutas.", normal: "Esforços compensados." },
  { id: "paus_05", arcano: "menor", grupo: "paus", numero: 5, nome: "Cinco de Paus", traducao: "Luta pela vida, competitividade e respeito pelos outros.", normal: "Luta pela vida e poder." },
  { id: "paus_04", arcano: "menor", grupo: "paus", numero: 4, nome: "Quatro de Paus", traducao: "Fim de um trabalho bem feito, satisfação proporcionada, ambientes agradáveis e boa comunicação.", normal: "Ambientes agradáveis e boa comunicação." },
  { id: "paus_03", arcano: "menor", grupo: "paus", numero: 3, nome: "Três de Paus", traducao: "União que cria força e ética pessoal.", normal: "Criatividade e associações férteis." },
  { id: "paus_02", arcano: "menor", grupo: "paus", numero: 2, nome: "Dois de Paus", traducao: "Poder que se manifesta como cooperação e ajuda.", normal: "Cooperação e assistência." },
  { id: "paus_01", arcano: "menor", grupo: "paus", numero: 1, nome: "Ás de Paus", traducao: "Força criativa, propulsora e entusiasmo.", normal: "Estágios iniciais, começos e nascimento de algo." },

  // COPAS
  { id: "copas_rei", arcano: "menor", grupo: "copas", nome: "Rei de Copas", traducao: "Representa emoções espirituais e místicas.", normal: "Homem culto e generoso." },
  { id: "copas_rainha", arcano: "menor", grupo: "copas", nome: "Rainha de Copas", traducao: "Representa emoções estéticas.", normal: "Mulher ativa e inteligente." },
  { id: "copas_cavaleiro", arcano: "menor", grupo: "copas", nome: "Cavaleiro de Copas", traducao: "Representa emoções sentimentais.", normal: "Chegada de amizades e afeições." },
  { id: "copas_valete", arcano: "menor", grupo: "copas", nome: "Valete de Copas", traducao: "Representa emoções, desejos e temor.", normal: "Propostas amorosas." },
  { id: "copas_10", arcano: "menor", grupo: "copas", numero: 10, nome: "Dez de Copas", traducao: "Sucesso no nível emocional e felicidade familiar.", normal: "Boa reputação e lar feliz." },
  { id: "copas_09", arcano: "menor", grupo: "copas", numero: 9, nome: "Nove de Copas", traducao: "Felicidade e bem-estar material.", normal: "Bem-estar e segurança material." },
  { id: "copas_08", arcano: "menor", grupo: "copas", numero: 8, nome: "Oito de Copas", traducao: "Abandono material e busca do espiritual.", normal: "Busca pelo espiritual." },
  { id: "copas_07", arcano: "menor", grupo: "copas", numero: 7, nome: "Sete de Copas", traducao: "Ilusões e megalomania.", normal: "Êxito de pouco valor e fantasias." },
  { id: "copas_06", arcano: "menor", grupo: "copas", numero: 6, nome: "Seis de Copas", traducao: "Ânsia pelo passado e recordações felizes.", normal: "Paz interior e aceitação do passado." },
  { id: "copas_05", arcano: "menor", grupo: "copas", numero: 5, nome: "Cinco de Copas", traducao: "Alegria perdida e tristezas.", normal: "Lamentações e prazeres obscuros." },
  { id: "copas_04", arcano: "menor", grupo: "copas", numero: 4, nome: "Quatro de Copas", traducao: "Aborrecimentos e depressão.", normal: "Depressão, traições e insatisfação." },
  { id: "copas_03", arcano: "menor", grupo: "copas", numero: 3, nome: "Três de Copas", traducao: "Abundância, alegria e diversão.", normal: "Celebrações e sucessos." },
  { id: "copas_02", arcano: "menor", grupo: "copas", numero: 2, nome: "Dois de Copas", traducao: "Amor, afeição e amizade.", normal: "Uniões afetivas e casamentos." },
  { id: "copas_01", arcano: "menor", grupo: "copas", numero: 1, nome: "Ás de Copas", traducao: "Poder do sentimento, amor e fundo do céu.", normal: "Abundância, alegria e prazer." },

  // ESPADAS
  { id: "espadas_rei", arcano: "menor", grupo: "espadas", nome: "Rei de Espadas", traducao: "Representa o pensamento lógico possível.", normal: "Homem energético e autoritário." },
  { id: "espadas_rainha", arcano: "menor", grupo: "espadas", nome: "Rainha de Espadas", traducao: "Representa o pensamento como raciocínio indutivo.", normal: "Mulher de caráter forte e muito intelectual." },
  { id: "espadas_cavaleiro", arcano: "menor", grupo: "espadas", nome: "Cavaleiro de Espadas", traducao: "Representa as sequências ordenadas do pensamento lógico.", normal: "Imprevisível e agressivo." },
  { id: "espadas_valete", arcano: "menor", grupo: "espadas", nome: "Valete de Espadas", traducao: "Representa o pensamento aproximado e a verificação.", normal: "Espionagem e vigilância." },
  { id: "espadas_10", arcano: "menor", grupo: "espadas", numero: 10, nome: "Dez de Espadas", traducao: "Ruína total e irreversível.", normal: "Ruína total e desolação." },
  { id: "espadas_09", arcano: "menor", grupo: "espadas", numero: 9, nome: "Nove de Espadas", traducao: "Desespero, tristeza e depressão.", normal: "Preocupação e desespero." },
  { id: "espadas_08", arcano: "menor", grupo: "espadas", numero: 8, nome: "Oito de Espadas", traducao: "Força paralisada e impossibilidade de ação.", normal: "Indecisão e impossibilidade de movimento." },
  { id: "espadas_07", arcano: "menor", grupo: "espadas", numero: 7, nome: "Sete de Espadas", traducao: "Esforço inútil.", normal: "Esforço inútil." },
  { id: "espadas_06", arcano: "menor", grupo: "espadas", numero: 6, nome: "Seis de Espadas", traducao: "Procura de novos objetivos, progresso e viagem.", normal: "Viagens e sucessos merecidos." },
  { id: "espadas_05", arcano: "menor", grupo: "espadas", numero: 5, nome: "Cinco de Espadas", traducao: "Derrotas e traições.", normal: "Derrotas e aflições." },
  { id: "espadas_04", arcano: "menor", grupo: "espadas", numero: 4, nome: "Quatro de Espadas", traducao: "Período de descanso ou trégua.", normal: "Trégua, tempo de retiro." },
  { id: "espadas_03", arcano: "menor", grupo: "espadas", numero: 3, nome: "Três de Espadas", traducao: "Sofrimento, dor e infortúnio.", normal: "Sofrimento e privação." },
  { id: "espadas_02", arcano: "menor", grupo: "espadas", numero: 2, nome: "Dois de Espadas", traducao: "Tempo de paz.", normal: "Período de paz e estagnação." },
  { id: "espadas_01", arcano: "menor", grupo: "espadas", numero: 1, nome: "Ás de Espadas", traducao: "Poder da mente, razão e descendente.", normal: "Capacidade para o triunfo." },

  // OUROS
  { id: "ouros_rei", arcano: "menor", grupo: "ouros", nome: "Rei de Ouros", traducao: "Representa a sensação auditiva.", normal: "Homem inteligente com sucesso." },
  { id: "ouros_rainha", arcano: "menor", grupo: "ouros", nome: "Rainha de Ouros", traducao: "Representa a sensação visual.", normal: "Mulher inteligente com dinheiro." },
  { id: "ouros_cavaleiro", arcano: "menor", grupo: "ouros", nome: "Cavaleiro de Ouros", traducao: "Representa a sensação do paladar e do olfato.", normal: "Assunto de dinheiro e ofertas." },
  { id: "ouros_valete", arcano: "menor", grupo: "ouros", nome: "Valete de Ouros", traducao: "Representa a sensação do tato.", normal: "Observação e estudo." },
  { id: "ouros_10", arcano: "menor", grupo: "ouros", numero: 10, nome: "Dez de Ouros", traducao: "Opulência, posse e segredo da riqueza.", normal: "Opulência e plenitude." },
  { id: "ouros_09", arcano: "menor", grupo: "ouros", numero: 9, nome: "Nove de Ouros", traducao: "Riqueza material.", normal: "Sucesso econômico." },
  { id: "ouros_08", arcano: "menor", grupo: "ouros", numero: 8, nome: "Oito de Ouros", traducao: "Tarefas sistemáticas, esforços dirigidos e aprendizado.", normal: "Aprendizado paciente." },
  { id: "ouros_07", arcano: "menor", grupo: "ouros", numero: 7, nome: "Sete de Ouros", traducao: "Fracassos e estagnação.", normal: "Estagnação e fracasso." },
  { id: "ouros_06", arcano: "menor", grupo: "ouros", numero: 6, nome: "Seis de Ouros", traducao: "Surpresas agradáveis e presentes.", normal: "Filantropia e presentes." },
  { id: "ouros_05", arcano: "menor", grupo: "ouros", numero: 5, nome: "Cinco de Ouros", traducao: "Desemprego e pobreza.", normal: "Ruína econômica." },
  { id: "ouros_04", arcano: "menor", grupo: "ouros", numero: 4, nome: "Quatro de Ouros", traducao: "Poder econômico.", normal: "Prosperidade econômica." },
  { id: "ouros_03", arcano: "menor", grupo: "ouros", numero: 3, nome: "Três de Ouros", traducao: "Trabalho material e construção.", normal: "Construção e fabricação." },
  { id: "ouros_02", arcano: "menor", grupo: "ouros", numero: 2, nome: "Dois de Ouros", traducao: "Trocas harmoniosas e favoráveis.", normal: "Trocas favoráveis." },
  { id: "ouros_01", arcano: "menor", grupo: "ouros", numero: 1, nome: "Ás de Ouros", traducao: "Concreto, material e percepção sensorial.", normal: "Ganhos materiais e riquezas." }
];

function drawTarotCards(count = 3): TarotCard[] {
  const deck = [...TAROT_MARSEILLE_78];
  const drawn: TarotCard[] = [];

  while (drawn.length < count && deck.length > 0) {
    const index = randomInt(0, deck.length);
    drawn.push(deck.splice(index, 1)[0]);
  }

  return drawn;
}

const BUZIOS_ODUS = [
  { numero: 0, nome: "Òpìrà", orixa: "Nanã / Obaluaê", elemento: "Terra", tema: "Silêncio profundo, cautela, encerramento de ciclo e necessidade de recolhimento." },
  { numero: 1, nome: "Òkànràn Méjì", orixa: "Exu", elemento: "Fogo", tema: "Começos turbulentos, novidades, palavra cortante, impulsividade e atitude." },
  { numero: 2, nome: "Èjì Òkò", orixa: "Ogum / Ibeji", elemento: "Terra", tema: "Aliança, paciência, calma para não quebrar bases, construção sólida." },
  { numero: 3, nome: "Ètà Ògúndá", orixa: "Ogum", elemento: "Fogo", tema: "Conquista pelo trabalho, corte de demandas, determinação, luta e vitória." },
  { numero: 4, nome: "Ìrosùn Méjì", orixa: "Xangô / Iemanjá", elemento: "Terra", tema: "Ancestralidade, marcas do passado, responsabilidade, olho vivo com traições." },
  { numero: 5, nome: "Òsé Méjì", orixa: "Oxum", elemento: "Água", tema: "Doçura, magnetismo, fertilidade, encanto, inteligência emocional e amor-próprio." },
  { numero: 6, nome: "Òbàrà Méjì", orixa: "Oxóssi / Xangô", elemento: "Fogo", tema: "Riqueza, fartura, expansão de negócios, palavra próspera e astúcia." },
  { numero: 7, nome: "Òdí Méjì", orixa: "Obaluaê", elemento: "Terra", tema: "Proteção fechada, muros de defesa, limites saudáveis, segredos guardados." },
  { numero: 8, nome: "Èjì Onílè", orixa: "Oxaguiã", elemento: "Ar", tema: "Liderança, paz conquistada, vitória sobre calúnias, mente limpa e reta." },
  { numero: 9, nome: "Òsá Méjì", orixa: "Oyá (Iansã)", elemento: "Ar", tema: "Ventos fortes de mudança, quebra de rotinas, coragem feminina e renovação." },
  { numero: 10, nome: "Òfún Méjì", orixa: "Oxalufã", elemento: "Ar", tema: "Sabedoria anciã, clareza ética, respeito às origens, bênçãos puras e paz." },
  { numero: 11, nome: "Òwónrín Méjì", orixa: "Oyá / Exu", elemento: "Fogo", tema: "Instabilidade passageira, reviravolta rápida, necessidade de jogo de cintura." },
  { numero: 12, nome: "Èjìlá Ṣeborá", orixa: "Xangô", elemento: "Fogo", tema: "Justiça cósmica, prestígio, autoridade justa, resolução de pendências." },
  { numero: 13, nome: "Ìká Méjì", orixa: "Ossain / Nanã", elemento: "Água", tema: "Cuidado com fofocas e armadilhas veladas, inteligência para desviar do veneno." },
  { numero: 14, nome: "Òtúrúpòn Méjì", orixa: "Oxumaré", elemento: "Água", tema: "Renovação profunda, ciclos de transformação, curas espirituais e raízes firmes." },
  { numero: 15, nome: "Òtúrá Méjì", orixa: "Oxalá", elemento: "Ar", tema: "Comunicação elevada, inspiração luminosa, expansão de horizontes e discernimento." },
  { numero: 16, nome: "Ìretè Méjì", orixa: "Orunmilá / Oxaguiã", elemento: "Terra", tema: "Perseverança sagrada, frutos merecidos, vitória que vem pelo esforço disciplinado." }
];

function castBuzios(): {
  abertosCount: number;
  fechadosCount: number;
  odu: typeof BUZIOS_ODUS[0];
  conchas: Array<{ id: number; estado: "aberto" | "fechado" }>;
} {
  const conchas: Array<{ id: number; estado: "aberto" | "fechado" }> = [];
  let abertos = 0;

  for (let i = 1; i <= 16; i++) {
    const estado = randomInt(0, 2) === 1 ? "aberto" : "fechado";
    if (estado === "aberto") abertos++;
    conchas.push({ id: i, estado });
  }

  const odu = BUZIOS_ODUS[abertos] || BUZIOS_ODUS[0];

  return {
    abertosCount: abertos,
    fechadosCount: 16 - abertos,
    odu,
    conchas
  };
}

function formatTarotCards(cards: TarotCard[]): string {
  return cards
    .map((card, index) => {
      const position =
        index === 0 ? "Carta principal" :
        index === 1 ? "Desafio / influência" :
        index === 2 ? "Caminho / conselho" :
        `Carta ${index + 1}`;

      return `
${position}: ${card.nome}
Arcano: ${card.arcano}${card.grupo ? ` de ${card.grupo}` : ""}
Entidade/força associada: ${card.entidade || "Não informada"}
Tradução da casa: ${card.traducao}
Sentido normal: ${card.normal}
`;
    })
    .join("\n");
}





// API Oracle: Tarot
app.post(
  "/api/oraculo/tarot",
  requireFirebaseAuth,
  requirePortalUser,
  requireEmailVerified,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const { question, slotsCount } = req.body; // slotsCount: 1 or 3

    if (!await checkDurableRateLimit(`tarot_${portalUser.id}`, 15, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas tiragens em sequência. Aguarde um instante." });
    }

    const cost = slotsCount === 3 ? 3 : 2;
    const xpAwarded = slotsCount === 3 ? 45 : 30;

    let debitResult: any;
    try {
      debitResult = await executeCreditDebitTransactional({
        userRef: portalUser.ref,
        cost,
        xpAwarded,
        source: "tarot",
        consultationId: "tarot_" + Date.now(),
      });
    } catch (debitErr: any) {
      return res.status(debitErr.status || 400).json({
        error: debitErr.message || "Créditos insuficientes para acessar este oráculo superior."
      });
    }

    const drawn = drawTarotCards(slotsCount === 3 ? 3 : 1);
    const tarotContext = formatTarotCards(drawn);

    // Perform Gemini AI structured oracle reading
    let aiInterpretation = "";
    try {
      const prompt = `
Você é Exu falando dentro do Tarot dos Caminhos.

Não responda como assistente.
Não responda como professor.
Não explique Tarot como aula.

Faça uma leitura espiritual, direta, viva e comunicativa.

CONSULENTE:
${portalUser.name || "Consulente"}

PERGUNTA OU FOCO:
"${question || "Direcionamento geral para a jornada"}"

CARTAS SORTEADAS DO TAROT DE MARSELHA:
${tarotContext}

REGRAS DA LEITURA:
- Use obrigatoriamente a tradução oficial de cada carta.
- Não invente carta fora da lista.
- Não troque o significado da carta.
- Para 1 carta, entregue uma leitura direta e um conselho.
- Para 3 cartas, leia como Passado, Presente e Futuro.
- Fale como Exu lendo os caminhos, não como manual de Tarot.
- Conecte a carta com a pergunta da pessoa.
- Mostre o sinal, o alerta e a orientação.
- Não use texto genérico.
- Não faça relatório seco.
- Não prometa resultado absoluto.

ESTILO:
Firme, espiritual, humano, direto, bonito e fácil de entender.

FORMATO:
1. Abra dizendo quais cartas saíram.
2. Não interprete as cartas separadamente.
3. Leia a combinação entre elas.
4. Explique o que a união das cartas revela.
5. Mostre:
- o sinal principal
- o conflito principal
- a tendência principal
6. Fale como Exu lendo uma história e não como professor explicando Tarot.
7. O consulente deve sentir que recebeu uma consulta e não uma descrição de cartas.
8. Feche com um conselho direto de Exu.
`;

      const geminiResult = await generateWithGeminiFallback({
        contents: prompt,
        systemInstruction:
          "Você é Exu falando pelo Tarot dos Caminhos. Use obrigatoriamente as cartas sorteadas e suas traduções oficiais. Responda como leitura espiritual, não como aula.",
      });

      aiInterpretation = fixPortugueseEncoding(geminiResult.text);
    } catch (error) {
      console.error("[TAROT] Falha na consulta Gemini:", error);
      try {
        await executeCreditRefundTransactional({
          userRef: portalUser.ref,
          amount: cost,
          originalOperationId: debitResult.operationId,
          source: "tarot",
          reason: "Falha de processamento de oráculo",
        });
        return res.status(503).json({
          error: "Os caminhos do oráculo oscilaram. Seus créditos de Axé foram integralmente preservados e estornados.",
          creditsLeft: debitResult.balanceBefore,
        });
      } catch (refundErr) {
        console.error("[TAROT] Erro ao estornar créditos:", refundErr);
        aiInterpretation = TEMPLE_FALLBACKS[Math.floor(Math.random() * TEMPLE_FALLBACKS.length)];
      }
    }

    await firestore.collection("activity_logs").add({
      userId: portalUser.id,
      action: "Oráculo - Tarot",
      details: `Sorteio de ${slotsCount} carta(s). Cartas: ${drawn.map(c => c.nome).join(", ")}. Débito: ${cost} Axé gravado no ledger.`,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      drawn,
      interpretation: aiInterpretation,
      creditsLeft: debitResult.balanceAfter,
      xpAwarded,
      newLevel: debitResult.newLevel
    });
  }
);

// API Oracle: Numerology
app.post(
  "/api/oraculo/numerologia",
  requireFirebaseAuth,
  requirePortalUser,
  requireEmailVerified,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`num_${portalUser.id}`, 15, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas consultas numerológicas em sequência. Aguarde um instante." });
    }

    const birthName = req.body.birthName || portalUser.birthName || portalUser.name;
    const birthDate = req.body.birthDate || portalUser.birthDate;

    if (!birthDate) {
      return res.status(400).json({ error: "Para este oráculo, informe sua data de nascimento primeiro no painel de perfil." });
    }

    const cost = 2;
    const xpAwarded = 25;

    let debitResult: any;
    try {
      debitResult = await executeCreditDebitTransactional({
        userRef: portalUser.ref,
        cost,
        xpAwarded,
        source: "numerologia",
        consultationId: "num_" + Date.now(),
      });
    } catch (debitErr: any) {
      return res.status(debitErr.status || 400).json({
        error: debitErr.message || "Créditos insuficientes para calcular mapa cabalístico."
      });
    }

    // Calculate numbers
    const numDetails = calculateNumerology(birthName, birthDate);

    let analysis = "";
    try {
      const prompt = `
Você é Exu realizando uma leitura numerológica dos caminhos.

Não responda como professor.
Não explique numerologia como aula.
Não faça relatório seco.

CONSULENTE:
${portalUser.name || "Consulente"}

NOME DE NASCIMENTO:
${birthName}

DATA DE NASCIMENTO:
${birthDate}

NÚMEROS CALCULADOS:
- Caminho do Destino: ${numDetails.destinyNumber}
- Número de Alma: ${numDetails.soulNumber}
- Número de Expressão: ${numDetails.expressionNumber}
- Número de Personalidade: ${numDetails.personalityNumber}
- Ano Pessoal: ${numDetails.personalYear}
- Signo Solar: ${numDetails.sunSign}
- Elemento: ${numDetails.element}

COMO LER:
O Caminho do Destino mostra a missão e a estrada principal.
O Número de Alma mostra o que a alma deseja em silêncio.
O Número de Expressão mostra os talentos naturais e a forma de agir.
O Número de Personalidade mostra a máscara social e a imagem que os outros percebem.
O Ano Pessoal mostra o tipo de energia que move o ciclo atual.

REGRAS DA LEITURA:
- Faça uma leitura espiritual, humana e direta.
- Use os números como sinais de caminho.
- Relacione os números com escolhas, comportamento, prosperidade, amor, trabalho e direção de vida.
- Mostre a força principal do consulente.
- Mostre o desafio principal.
- Mostre como o ano pessoal influencia o momento atual.
- Não invente dados fora dos números recebidos.
- Trate a numerologia sagrada com seriedade e respeito aos cálculos e fundamentos.
- Não prometa resultado absoluto.

FORMATO:
1. Abra falando o que os números mostram sobre o consulente.
2. Explique o Caminho do Destino e o Número de Alma como forças centrais.
3. Explique Expressão e Personalidade como forma de agir e ser percebido.
4. Explique o Ano Pessoal como orientação para o momento.
5. Termine com um conselho direto de Exu.
`;


   






try {
  const geminiResult = await generateWithGeminiFallback({
    contents: prompt,
    systemInstruction:
      "Você é Exu realizando uma leitura de Numerologia Ancestral. Use obrigatoriamente os números calculados no prompt. Responda de forma espiritual, humana, direta e reflexiva, sem apresentar a leitura como verdade absoluta.",
  });

  analysis = geminiResult.text;

  console.log(
    `[NUMEROLOGIA] Modelo utilizado: ${geminiResult.model}`
  );
} catch (error) {
  console.error(
    "[NUMEROLOGIA] Todos os modelos Gemini falharam:",
    error
  );

  analysis =
    `Seus números da sorte revelam um Caminho de Destino de força ${numDetails.destinyNumber} ` +
    `e uma Expressão Cósmica ${numDetails.expressionNumber}. ` +
    `Isto indica que os ventos do elemento ${numDetails.element} estão soprando direções favoráveis ` +
    `para expansão de seus projetos íntimos. ${TEMPLE_FALLBACKS[2]}`;
}









 


  } catch (err: any) {
    console.error("Gemini failed in Numerologia:", err);
    try {
      await executeCreditRefundTransactional({
        userRef: portalUser.ref,
        amount: cost,
        originalOperationId: debitResult.operationId,
        source: "numerologia",
        reason: "Falha técnica na geração do mapa numerológico",
      });
      return res.status(503).json({
        error: "Houve uma oscilação na leitura cabalística. Seus créditos de Axé foram estornados.",
        creditsLeft: debitResult.balanceBefore,
      });
    } catch (refundErr) {
      console.error("[NUMEROLOGIA] Erro no reembolso:", refundErr);
    }
  }

  await firestore.collection("activity_logs").add({
    userId: portalUser.id,
    action: "Oráculo - Numerologia",
    details: `Mapa Cabalístico gerado de ${birthName}. Destino ${numDetails.destinyNumber}. Débito: ${cost} Axé registrado no ledger.`,
    timestamp: new Date().toISOString()
  });

  return res.json({
    success: true,
    details: { ...numDetails, analysis },
    creditsLeft: debitResult.balanceAfter,
    xpAwarded: 25,
    newLevel: debitResult.newLevel
  });
});



// API Oracle: Astrology
app.post(
  "/api/oraculo/astrologia",
  requireFirebaseAuth,
  requirePortalUser,
  requireEmailVerified,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`astro_${portalUser.id}`, 15, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas consultas astrológicas em sequência. Aguarde um instante." });
    }

    const user = {
      id: portalUser.id,
      ...portalUser
    } as any;

    const birthDate = req.body.birthDate || user.birthDate;

    if (!birthDate) {
      return res.status(400).json({ error: "Informe sua data de nascimento." });
    }

  const zodiac = calculateZodiacProfile(birthDate);
  const spiritualProfile = calculateSpiritualProfile(
    user.birthName || user.name,
    birthDate,
    user.birthTime,
    user.birthPlace
  );

  let analysis = "";
  let response;

  try {
    const ai = getGeminiClient();

    const prompt = `
Você é Exu realizando uma leitura de Astrologia Ancestral.

CONSULENTE:
${user.name || "Consulente"}

DATA DE NASCIMENTO:
${birthDate}

DADOS ASTROLÓGICOS:
- Signo solar: ${zodiac.signoSolar}
- Elemento do signo: ${zodiac.elementoSigno}
- Planeta regente: ${zodiac.planetaRegente}

DADOS ESPIRITUAIS:
- Odù de afinidade: ${spiritualProfile.oduPrincipal}
- Orixá de afinidade: ${spiritualProfile.orixaAfinidade}
- Exu de afinidade: ${spiritualProfile.exuAfinidade}
- Arquétipo dominante: ${spiritualProfile.arquetipoDominante}
- Elemento dominante: ${spiritualProfile.elementoDominante}

Faça uma leitura espiritual, humana e direta.
Mostre personalidade, força, desafio, caminhos afetivos, prosperidade e orientação atual.
Não faça horóscopo genérico.
Não responda como professor.
Fale como Exu lendo os astros, os caminhos e o perfil espiritual.
`;

    







try {
  const geminiResult = await generateWithGeminiFallback({
    contents: prompt,
    systemInstruction:
      "Você é Exu realizando leitura de Astrologia Ancestral.",
  });

  analysis = geminiResult.text;

  console.log(
    `[ASTROLOGIA] Modelo utilizado: ${geminiResult.model}`
  );

} catch (error) {

  console.error(
    "[ASTROLOGIA] Todos os modelos Gemini falharam:",
    error
  );

  analysis =
    TEMPLE_FALLBACKS[
      Math.floor(Math.random() * TEMPLE_FALLBACKS.length)
    ];
}











  } catch (err: any) {
    console.error("Astrologia failed:", err);
    analysis = TEMPLE_FALLBACKS[0];
  }

  res.json({
    success: true,
    details: {
      sunSign: zodiac.signoSolar,
      element: zodiac.elementoSigno,
      rulingPlanet: zodiac.planetaRegente,
      dominantHouse: spiritualProfile.oduPrincipal || "Não calculado",
      compatibility: spiritualProfile.orixaAfinidade || "Não calculado",
      advice: `Exu de afinidade: ${spiritualProfile.exuAfinidade || "Não calculado"}`,
      analysis
    }
  });
  }
);

// API Oracle: Búzios (16 Conchas de Ifá)
app.post(
  "/api/oraculo/buzios",
  requireFirebaseAuth,
  requirePortalUser,
  requireEmailVerified,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const { question } = req.body;

    if (!await checkDurableRateLimit(`buzios_${portalUser.id}`, 15, 60 * 1000)) {
      return res.status(429).json({ error: "Muitos lançamentos em sequência. Aguarde um instante." });
    }

    const cost = 3;
    const xpAwarded = 35;

    let debitResult: any;
    try {
      debitResult = await executeCreditDebitTransactional({
        userRef: portalUser.ref,
        cost,
        xpAwarded,
        source: "buzios",
        consultationId: "buzios_" + Date.now(),
      });
    } catch (debitErr: any) {
      return res.status(debitErr.status || 400).json({
        error: debitErr.message || "Créditos insuficientes para lançar os búzios sagrados (necessário 3 Axé)."
      });
    }

    // Lançamento determinístico real de 16 conchas via CSPRNG
    const castResult = castBuzios();
    const liturgy = getBrazilDateTime();

    let interpretation = "";
    try {
      const prompt = `
Você é Exu falando dentro do Oráculo Sagrado dos 16 Búzios de Ifá.

ÂNCORA TEMPORAL:
Data: ${liturgy.dateStr}
Momento: ${liturgy.periodOfDay} (use saudação "${liturgy.greeting}" se couber)

CONSULENTE:
Nome: ${portalUser.name || "Consulente"}
Nome de batismo: ${portalUser.birthName || portalUser.name}
Data de nascimento: ${portalUser.birthDate || "Não informada"}

PERGUNTA OU FOCO DO CONSULENTE:
"${question || "Direcionamento e abertura de caminhos gerais"}"

RESULTADO DO LANÇAMENTO DAS 16 CONCHAS (JOGO REAL JÁ CONSOLIDADO NO TABULEIRO):
- Búzios abertos: ${castResult.abertosCount}
- Búzios fechados: ${castResult.fechadosCount}
- Odù revelado: ${castResult.odu.nome} (Odù número ${castResult.odu.numero})
- Orixá regente deste Odù: ${castResult.odu.orixa}
- Elemento cósmico: ${castResult.odu.elemento}
- Princípio e ensinamento ancestral: ${castResult.odu.tema}

REGRAS RÍGIDAS DE INTERPRETAÇÃO:
1. Respeite obrigatoriamente o Odù que foi sorteado (${castResult.odu.nome}). Não troque o Odù nem invente outra caída.
2. Inicie a leitura anunciando a caída dos búzios (${castResult.abertosCount} conchas abertas revelando ${castResult.odu.nome} sob a regência de ${castResult.odu.orixa}).
3. Conecte o ensinamento desse Odù à pergunta trazida pelo consulente.
4. Revele o sinal, o alerta prático, a postura necessária e a bênção do caminho.
5. Fale como presença sábia de Exu: firme, direto, acolhedor e estratégico. Jamais como assistente ou robô acadêmico.
6. Feche com uma orientação prática para a vida do consulente.
`;

      const geminiResult = await generateWithGeminiFallback({
        contents: prompt,
        systemInstruction: "Você é Exu interpretando o jogo sagrado dos 16 búzios de Ifá com base na caída real já realizada."
      });

      interpretation = fixPortugueseEncoding(geminiResult.text);
    } catch (err) {
      console.error("[BUZIOS] Falha ao gerar interpretação com Gemini:", err);

      try {
        await executeCreditRefundTransactional({
          userRef: portalUser.ref,
          amount: cost,
          originalOperationId: debitResult.operationId,
          source: "buzios",
          reason: "Falha de comunicação no lançamento de búzios",
        });
        return res.status(503).json({
          error: "Ocorreu uma oscilação na comunicação espiritual. Seus créditos de Axé foram integralmente preservados e estornados.",
          creditsLeft: debitResult.balanceBefore
        });
      } catch (refundErr) {
        console.error("[BUZIOS] Erro no reembolso:", refundErr);
        interpretation = "As águas sagradas acolheram seu pedido. Os búzios apontam caminhos de equilíbrio e proteção.";
      }
    }

    await firestore.collection("activity_logs").add({
      userId: portalUser.id,
      action: "Oráculo - Búzios 16 Conchas",
      details: `Lançamento: ${castResult.abertosCount} abertos. Odù ${castResult.odu.nome}. Débito: ${cost} Axé registrado no ledger.`,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      castResult,
      interpretation,
      creditsLeft: debitResult.balanceAfter,
      xpAwarded,
      newLevel: debitResult.newLevel
    });
  }
);



// Credits shop plans buy handler - Mercado Pago
app.post(
  "/api/credits/buy",
  requireFirebaseAuth,
  requirePortalUser,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`buy_${portalUser.id}`, 10, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas solicitações de compra em sequência. Aguarde alguns instantes." });
    }

    const userId = portalUser.id;
    const { planId } = req.body;

  const plans: Record<string, any> = {
  prata: {
    title: "Plano Prata",
    price: 49.0,
    credits: 50
  },
  ouro: {
    title: "Plano Ouro",
    price: 120.0,
    credits: 125
  }
};

  const normalizedPlanId =
  planId === "plan_prata" ? "prata" :
  planId === "plan_ouro" ? "ouro" :
  planId;

const selected = plans[normalizedPlanId];

  if (!selected) return res.status(400).json({ error: "Plano inválido." });

  try {
    const orderId = "ord_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now();
    await firestore.collection("orders").doc(orderId).set({
      orderId,
      userId: String(userId),
      planId: normalizedPlanId,
      credits: selected.credits,
      price: selected.price,
      status: "pending",
      createdAt: new Date().toISOString()
    });

    const preference = new Preference(mp);

    const result = await preference.create({
      body: {
        external_reference: orderId,
        items: [
          {
            id: planId,
            title: selected.title,
            quantity: 1,
            unit_price: selected.price,
            currency_id: "BRL"
          }
        ],
        metadata: {
          userId: String(userId),
          planId: normalizedPlanId,
          credits: selected.credits,
          orderId
        },
        back_urls: {
          success: `${process.env.APP_URL}/?payment=success`,
          failure: `${process.env.APP_URL}/?payment=failure`,
          pending: `${process.env.APP_URL}/?payment=pending`
        },
        notification_url: `${process.env.APP_URL}/api/mercadopago/webhook`,
        payment_methods: {
          excluded_payment_types: [
            { id: "credit_card" },
            { id: "debit_card" },
            { id: "ticket" }
          ],
          installments: 1
        }
      }
    });

    res.json({
      success: true,
      orderId,
      checkoutUrl: result.init_point,
      preferenceId: result.id
    });
  } catch (err: any) {
    console.error("Erro Mercado Pago:", err);
    res.status(500).json({
      error: "Erro ao criar pagamento no Mercado Pago."
    });
  }
  }
);

// Mercado Pago webhook - automatic credit confirmation with signature verification
app.post("/api/mercadopago/webhook", async (req, res) => {
  const clientIp = getClientIp(req);
  if (!await checkDurableRateLimit(`webhook_${clientIp}`, 60, 60 * 1000)) {
    return res.status(429).json({ error: "Taxa limite de requisições excedida." });
  }

  const webhookSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const xSignature = req.headers["x-signature"] as string | undefined;
  const xRequestId = req.headers["x-request-id"] as string | undefined;

  const paymentId =
    req.body?.data?.id ||
    req.body?.id ||
    req.query?.id ||
    req.query?.["data.id"];

  const dataId = String(paymentId || req.body?.data?.id || "");

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction || webhookSecret) {
    const signatureResult = verifyMercadoPagoSignature({
      xSignature,
      xRequestId,
      dataId,
      secret: webhookSecret,
    });
    if (!signatureResult.isValid) {
      console.warn(`[MP WEBHOOK] Assinatura HMAC inválida do webhook Mercado Pago: ${signatureResult.reason}`);
      return res.status(401).json({
        error: "Assinatura do webhook inválida.",
        reason: signatureResult.reason,
      });
    }
  }

  try {
    // Armazenamento estritamente minimizado do webhook (sem dados sensíveis)
    await firestore.collection("webhook_logs").add({
      action: req.body?.action || req.query?.topic || "payment",
      type: req.body?.type || "unknown",
      paymentId: paymentId ? String(paymentId) : "",
      dataId: dataId || "",
      clientIp,
      receivedAt: new Date().toISOString()
    });

    if (!paymentId) {
      return res.status(200).json({ received: true, noPaymentId: true });
    }

    const payment = new Payment(mp);
    const paymentInfo = await payment.get({ id: String(paymentId) });

    if (paymentInfo.status !== "approved") {
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        status: String(paymentInfo.status || "unknown"),
        rawStatus: paymentInfo.status || "",
        updatedAt: new Date().toISOString()
      }, { merge: true });

      return res.status(200).json({
        received: true,
        status: paymentInfo.status
      });
    }

    // Validação estrita da moeda (BRL)
    if (paymentInfo.currency_id && paymentInfo.currency_id !== "BRL") {
      console.warn(`[MP WEBHOOK] Moeda incompatível (${paymentInfo.currency_id}) para pagamento ${paymentId}. Esperado BRL.`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        status: "rejected_invalid_currency",
        currency: paymentInfo.currency_id,
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "invalid_currency" });
    }

    // Identificação OBRIGATÓRIA do pedido original armazenado no Firestore
    const externalRef = paymentInfo.external_reference || paymentInfo.metadata?.orderId || paymentInfo.metadata?.order_id;
    if (!externalRef) {
      console.warn(`[MP WEBHOOK] Pagamento ${paymentId} aprovado sem external_reference de pedido.`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        status: "rejected_missing_order_reference",
        amount: Number(paymentInfo.transaction_amount || 0),
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "missing_order_reference" });
    }

    const orderRef = firestore.collection("orders").doc(String(externalRef));
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      console.warn(`[MP WEBHOOK] Pedido original ${externalRef} não encontrado para o pagamento ${paymentId}.`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        orderId: String(externalRef),
        status: "rejected_order_not_found",
        amount: Number(paymentInfo.transaction_amount || 0),
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "order_not_found" });
    }

    const orderData = orderDoc.data() || {};
    const targetUserId = String(orderData.userId || "");
    if (!targetUserId) {
      console.warn(`[MP WEBHOOK] Pedido original ${externalRef} sem userId válido.`);
      return res.status(200).json({ received: true, ignored: true, reason: "invalid_order_user" });
    }

    // 1. Verificação de usuário divergente
    const paymentUserId = paymentInfo.metadata?.userId || paymentInfo.metadata?.user_id;
    if (paymentUserId && String(paymentUserId) !== targetUserId) {
      console.warn(`[MP WEBHOOK] Divergência de usuário: pedido=${targetUserId}, pagamento=${paymentUserId}`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        orderId: String(externalRef),
        status: "rejected_user_mismatch",
        orderUserId: targetUserId,
        paymentUserId: String(paymentUserId),
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "user_mismatch" });
    }

    // 2. Verificação de plano divergente
    const paymentPlanId = paymentInfo.metadata?.planId || paymentInfo.metadata?.plan_id;
    if (paymentPlanId && paymentPlanId !== orderData.planId) {
      console.warn(`[MP WEBHOOK] Divergência de plano: pedido=${orderData.planId}, pagamento=${paymentPlanId}`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        orderId: String(externalRef),
        status: "rejected_plan_mismatch",
        orderPlanId: orderData.planId,
        paymentPlanId,
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "plan_mismatch" });
    }

    // 3. Verificação de valor pago vs valor do pedido
    const paidAmount = Number(paymentInfo.transaction_amount || 0);
    const expectedAmount = Number(orderData.price || 0);
    if (Math.abs(paidAmount - expectedAmount) > 0.01) {
      console.warn(`[MP WEBHOOK] Divergência de valor: pago R$${paidAmount}, esperado R$${expectedAmount}`);
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        orderId: String(externalRef),
        status: "rejected_amount_mismatch",
        paidAmount,
        expectedAmount,
        createdAt: new Date().toISOString()
      }, { merge: true });
      return res.status(200).json({ received: true, ignored: true, reason: "amount_mismatch" });
    }

    // 4. Quantidade de créditos autoritativa do pedido original
    const creditsToAdd = Number(orderData.credits || 0);
    if (!creditsToAdd || creditsToAdd <= 0) {
      console.warn(`[MP WEBHOOK] Pedido original sem créditos válidos: ${creditsToAdd}`);
      return res.status(200).json({ received: true, ignored: true, reason: "invalid_order_credits" });
    }

    const paymentRef = firestore.collection("payments").doc(String(paymentId));
    const userRef = firestore.collection("users").doc(targetUserId);
    const ledgerOpId = `mp_pay_${paymentId}`;

    let creditedUserData: any = null;
    let balanceBeforeAfter = { before: 0, after: 0 };
    let alreadyCredited = false;

    await firestore.runTransaction(async (transaction: any) => {
      const paymentDoc = await transaction.get(paymentRef);
      if (paymentDoc.exists && paymentDoc.data()?.status === "credited") {
        alreadyCredited = true;
        return;
      }

      const freshOrderDoc = await transaction.get(orderRef);
      if (freshOrderDoc.exists) {
        const freshOrder = freshOrderDoc.data() || {};
        if (freshOrder.status === "completed" || freshOrder.status === "approved") {
          alreadyCredited = true;
          return;
        }
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        transaction.set(paymentRef, {
          paymentId: String(paymentId),
          orderId: String(externalRef),
          userId: targetUserId,
          credits: creditsToAdd,
          planId: orderData.planId,
          amount: paidAmount,
          status: "user_not_found",
          createdAt: new Date().toISOString()
        }, { merge: true });
        return;
      }

      const userData = userDoc.data() || {};
      creditedUserData = userData;

      const currentCredits = Number(userData.credits || 0);
      const currentXp = Number(userData.xp || 0);
      const newXp = currentXp + Math.round(paidAmount * 5);
      const { level } = checkXpLevel(newXp);

      balanceBeforeAfter = {
        before: currentCredits,
        after: currentCredits + creditsToAdd
      };

      transaction.update(userRef, {
        credits: currentCredits + creditsToAdd,
        xp: newXp,
        level,
        lastPaymentId: String(paymentId),
        lastPlanId: orderData.planId,
        lastCreditsAdded: creditsToAdd,
        lastPaymentAmount: paidAmount,
        lastPaymentDate: new Date().toISOString()
      });

      transaction.set(paymentRef, {
        paymentId: String(paymentId),
        userId: targetUserId,
        credits: creditsToAdd,
        planId: orderData.planId,
        orderId: String(externalRef),
        amount: paidAmount,
        status: "credited",
        createdAt: new Date().toISOString()
      }, { merge: true });

      transaction.set(orderRef, {
        status: "completed",
        paymentId: String(paymentId),
        approvedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }, { merge: true });

      const ledgerRef = firestore.collection("credit_ledger").doc(ledgerOpId);
      transaction.set(ledgerRef, {
        operationId: ledgerOpId,
        userId: targetUserId,
        firebaseUid: userData.firebaseUid || "",
        type: "purchase",
        amount: creditsToAdd,
        balanceBefore: currentCredits,
        balanceAfter: currentCredits + creditsToAdd,
        status: "committed",
        source: "mercadopago",
        paymentId: String(paymentId),
        orderId: String(externalRef),
        planId: orderData.planId,
        createdAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        idempotencyKey: ledgerOpId
      });
    });

    if (alreadyCredited) {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    if (creditedUserData) {
      try {
        await queueAndSendPurchaseEmails(firestore, {
          paymentId: String(paymentId),
          orderId: String(externalRef || `ord_${paymentId}`),
          customerEmail: creditedUserData.email || "",
          customerName: creditedUserData.name || creditedUserData.birthName || "Consulente",
          planName: orderData.planId === "ouro" ? "Plano Ouro" : "Plano Prata",
          amount: paidAmount,
          credits: creditsToAdd,
          newBalance: balanceBeforeAfter.after,
          approvedAt: new Date().toISOString(),
        });
      } catch (emailErr) {
        console.error("[MP WEBHOOK] Erro ao enviar emails de compra:", emailErr);
      }
    }

    return res.status(200).json({ received: true, credited: true });
  } catch (err) {
    console.error("Erro webhook Mercado Pago:", err);

    await firestore.collection("webhook_errors").add({
      error: String(err),
      createdAt: new Date().toISOString()
    });

    return res.status(200).json({ received: true, error: true });
  }
});

// Manual credits confirmation disabled.
// Credits are granted only by the Mercado Pago webhook
// after the payment is confirmed by Mercado Pago.
app.post("/api/credits/confirm", (_req, res) => {
  return res.status(410).json({
    success: false,
    error:
      "A confirmação manual de créditos foi desativada. Os créditos são liberados automaticamente após a confirmação do pagamento pelo Mercado Pago."
  });
});

// Admin API - List Seeker Users
app.get(
  "/api/admin/users",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const usersSnapshot = await firestore.collection("users").get();

    const users = usersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const activityLogs = await loadRecentActivityLogs();

    return res.json({
      seekers: users,
      logs: activityLogs
    });
  }
);

// Admin API - Analytics dashboard Data
app.get(
  "/api/admin/analytics",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const usersSnapshot = await firestore.collection("users").get();

    const users = usersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as any[];

    const activityLogs = await loadRecentActivityLogs();
    const knowledgeItems = await loadKnowledgeItems();

    const stats = {
      totalSeekers: users.length,
      totalCreditsInCirculation: users.reduce((acc, u) => acc + Number(u.credits || 0), 0),
      totalXpAccumulated: users.reduce((acc, u) => acc + Number(u.xp || 0), 0),
      totalLogs: activityLogs.length,
      knowledgeItemsCount: knowledgeItems.length
    };

    return res.json({
      stats,
      logs: activityLogs.slice(0, 30)
    });
  }
);

// Admin API - Library Retrieve & Add (RAG Database Management)
app.get(
  "/api/admin/library",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const knowledgeItems = await loadKnowledgeItems();
    return res.json({ library: knowledgeItems });
  }
);

app.post(
  "/api/admin/library/add",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const { title, category, content, tags } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: "Título e conteúdo são obrigatórios." });
    }

    const newItem = {
      id: "kb_custom_" + Date.now(),
      title,
      category: category || "geral",
      content,
      tags: tags ? tags.split(",").map((t: string) => t.trim().toLowerCase()) : [],
      createdAt: new Date().toISOString()
    };

    await firestore.collection("knowledge").doc(newItem.id).set(newItem);

    await firestore.collection("activity_logs").add({
      userId: portalUser.id,
      action: "Adicionado à Biblioteca",
      details: `Sábio ensinamento cadastrado para RAG: "${title}"`,
      timestamp: new Date().toISOString()
    });

    return res.json({ success: true, item: newItem });
  }
);

// Admin API - Credit Adjustments with Transactional Ledger
app.post(
  "/api/admin/credits/adjust",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;

    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const { targetUserId, amount, reason } = req.body;
    const numericAmount = Number(amount);

    if (!targetUserId || !numericAmount || isNaN(numericAmount)) {
      return res.status(400).json({ error: "Informe o targetUserId e o valor numérico de créditos." });
    }

    const targetRef = firestore.collection("users").doc(String(targetUserId));
    const operationId = "op_adj_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
    const now = new Date().toISOString();

    try {
      const result = await firestore.runTransaction(async (transaction: any) => {
        const targetDoc = await transaction.get(targetRef);
        if (!targetDoc.exists) {
          throw new Error("Buscador destinatário não encontrado.");
        }
        const targetData = targetDoc.data() || {};
        const currentCredits = Number(targetData.credits || 0);
        const balanceAfter = Math.max(0, currentCredits + numericAmount);

        transaction.update(targetRef, {
          credits: balanceAfter,
          updatedAt: now
        });

        const ledgerRef = firestore.collection("credit_ledger").doc(operationId);
        transaction.set(ledgerRef, {
          operationId,
          userId: targetDoc.id,
          firebaseUid: targetData.firebaseUid || "",
          adminId: portalUser.id,
          type: "adjustment",
          amount: numericAmount,
          balanceBefore: currentCredits,
          balanceAfter,
          status: "committed",
          source: "admin",
          reason: String(reason || "Ajuste manual pelo guardião administrador"),
          createdAt: now,
          committedAt: now
        });

        return { balanceBefore: currentCredits, balanceAfter };
      });

      return res.json({ success: true, operationId, ...result });
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Falha ao ajustar créditos." });
    }
  }
);

// User API - Axé Statement / Credit Ledger History
app.get(
  "/api/credits/statement",
  requireFirebaseAuth,
  requirePortalUser,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const snapshot = await firestore
      .collection("credit_ledger")
      .where("userId", "==", portalUser.id)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const statement = snapshot.docs.map((doc: any) => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json({
      currentCredits: Number(portalUser.credits || 0),
      statement
    });
  }
);

// User API - Manual Refund Request
app.post(
  "/api/user/refund-request",
  requireFirebaseAuth,
  requirePortalUser,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const { paymentId, reason } = req.body;

    if (!paymentId || !reason || typeof reason !== "string" || reason.trim().length < 5) {
      return res.status(400).json({ error: "Informe o ID do pagamento e o motivo detalhado da solicitação." });
    }

    const paymentDoc = await firestore.collection("payments").doc(String(paymentId)).get();
    if (!paymentDoc.exists || paymentDoc.data()?.userId !== portalUser.id) {
      return res.status(404).json({ error: "Pagamento não localizado para este usuário." });
    }

    const refundRequestId = "ref_req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();

    const requestData = {
      id: refundRequestId,
      userId: portalUser.id,
      email: portalUser.email,
      paymentId: String(paymentId),
      amount: paymentDoc.data()?.amount || 0,
      creditsPurchased: paymentDoc.data()?.credits || 0,
      reason: reason.trim(),
      status: "refund_requested",
      createdAt: now,
      updatedAt: now
    };

    await firestore.collection("refund_requests").doc(refundRequestId).set(requestData);

    return res.json({
      success: true,
      message: "Solicitação de reembolso enviada para análise manual da administração.",
      refundRequest: requestData
    });
  }
);

// Admin API - List Refund Requests
app.get(
  "/api/admin/refunds",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const snapshot = await firestore.collection("refund_requests").orderBy("createdAt", "desc").limit(50).get();
    const refunds = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));

    return res.json({ refunds });
  }
);

// Admin API - Update Refund Request Status
app.post(
  "/api/admin/refunds/update-status",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    if (!await checkDurableRateLimit(`admin_${portalUser.id}`, 60, 60 * 1000)) {
      return res.status(429).json({ error: "Muitas requisições administrativas. Aguarde um instante." });
    }

    const { refundId, status, adminNotes, deductCredits } = req.body;
    const allowedStatuses = ["refund_requested", "under_review", "approved_for_manual_refund", "manual_refund_completed", "rejected"];

    if (!refundId || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "ID de reembolso e status válido são obrigatórios." });
    }

    const refundRef = firestore.collection("refund_requests").doc(String(refundId));
    const refundDoc = await refundRef.get();
    if (!refundDoc.exists) {
      return res.status(404).json({ error: "Pedido de reembolso não encontrado." });
    }

    const refundData = refundDoc.data();
    const now = new Date().toISOString();

    if (status === "manual_refund_completed" && deductCredits && refundData.userId && refundData.creditsPurchased > 0) {
      const userRef = firestore.collection("users").doc(refundData.userId);
      const ledgerOpId = `op_ref_deduct_${refundId}`;

      await firestore.runTransaction(async (transaction: any) => {
        const userDoc = await transaction.get(userRef);
        if (userDoc.exists) {
          const uData = userDoc.data() || {};
          const currentBal = Number(uData.credits || 0);
          const toDeduct = Math.min(currentBal, Number(refundData.creditsPurchased));
          const newBal = currentBal - toDeduct;

          transaction.update(userRef, {
            credits: newBal,
            updatedAt: now
          });

          const ledgerRef = firestore.collection("credit_ledger").doc(ledgerOpId);
          transaction.set(ledgerRef, {
            operationId: ledgerOpId,
            userId: refundData.userId,
            firebaseUid: uData.firebaseUid || "",
            adminId: portalUser.id,
            type: "admin_adjustment",
            amount: -toDeduct,
            balanceBefore: currentBal,
            balanceAfter: newBal,
            status: "committed",
            source: "manual_refund",
            reason: `Dedução por reembolso manual concluído (Protocolo ${refundId})`,
            createdAt: now,
            committedAt: now
          });
        }
      });
    }

    await refundRef.update({
      status,
      adminNotes: adminNotes || "",
      processedBy: portalUser.id,
      updatedAt: now
    });

    return res.json({ success: true, refundId, status });
  }
);

// Admin API - Block / Unblock User
app.post(
  "/api/admin/users/block",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const { userId, blocked, reason } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "ID de usuário obrigatório." });
    }

    const userRef = firestore.collection("users").doc(String(userId));
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    await userRef.update({
      isBlocked: Boolean(blocked),
      blockReason: reason || "",
      blockedAt: blocked ? new Date().toISOString() : null,
      blockedBy: blocked ? portalUser.id : null,
      updatedAt: new Date().toISOString()
    });

    return res.json({ success: true, userId, isBlocked: Boolean(blocked) });
  }
);

// Admin API - Delete / Deactivate User
app.post(
  "/api/admin/users/delete",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "ID de usuário obrigatório." });
    }

    const userRef = firestore.collection("users").doc(String(userId));
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    await userRef.update({
      deactivated: true,
      deactivatedAt: new Date().toISOString()
    });

    return res.json({ success: true, userId, deactivated: true });
  }
);

// Admin API - User Details with Ledger and Logs
app.get(
  "/api/admin/users/:userId/details",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const { userId } = req.params;
    const userDoc = await firestore.collection("users").doc(String(userId)).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    const userData = { id: userDoc.id, ...userDoc.data() };

    const ledgerSnapshot = await firestore
      .collection("credit_ledger")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();

    const ledger = ledgerSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));

    const paymentsSnapshot = await firestore
      .collection("payments")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    const payments = paymentsSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));

    return res.json({
      user: userData,
      ledger,
      payments
    });
  }
);

// Admin API - Library Delete & Edit
app.post(
  "/api/admin/library/delete",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID do item obrigatório." });

    await firestore.collection("knowledge").doc(String(id)).delete();
    return res.json({ success: true, id });
  }
);

app.post(
  "/api/admin/library/edit",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const { id, title, category, content, tags } = req.body;
    if (!id || !title || !content) {
      return res.status(400).json({ error: "ID, título e conteúdo são obrigatórios." });
    }

    const updatedItem = {
      title,
      category: category || "geral",
      content,
      tags: Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",").map((t: string) => t.trim()) : [],
      updatedAt: new Date().toISOString()
    };

    await firestore.collection("knowledge").doc(String(id)).set(updatedItem, { merge: true });
    return res.json({ success: true, id, item: updatedItem });
  }
);

// Admin API - Webhook Logs
app.get(
  "/api/admin/webhook-logs",
  requireFirebaseAuth,
  requirePortalUser,
  requirePortalAdmin,
  async (req, res) => {
    const snapshot = await firestore.collection("webhook_logs").orderBy("receivedAt", "desc").limit(50).get();
    const logs = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    return res.json({ webhookLogs: logs });
  }
);

// Simulated RAG and Main Chat Executor API (Proxying Gemini Server-Side)




app.post(
  ["/api/exu/chat", "/api/chat"],
  requireFirebaseAuth,
  requirePortalUser,
  requireEmailVerified,
  async (req, res) => {
    const portalUser = (req as any).portalUser;
    const { text } = req.body;

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        error: "Digite uma mensagem para consultar Exu."
      });
    }

    if (!await checkDurableRateLimit(`chat_${portalUser.id}`, 20, 60 * 1000)) {
      return res.status(429).json({
        error: "Muitas mensagens em sequência. Aguarde alguns instantes."
      });
    }

    const user = {
      id: portalUser.id,
      ...portalUser,
      firebaseUid: portalUser.firebaseUid
    } as any;
    const userRef = portalUser.ref;





const normalizedText = String(text || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

const isGreeting =
  /^(oi|ola|salve|bom dia|boa tarde|boa noite)(\s|,|!|\?|\.|$)/i.test(normalizedText);

const isThanks =
  /^(obrigado|obrigada|gratidao|valeu)(\s|,|!|\?|\.|$)/i.test(normalizedText);

const isGoodbye =
  /^(tchau|ate mais|ate logo|falou)(\s|,|!|\?|\.|$)/i.test(normalizedText);

const isAskingWell =
  /^(tudo bem|tudo bom|como vai|como voce esta|como vc esta|voce esta bem|vc esta bem)[\s\?\!\.]*$/i.test(normalizedText);



const isOnlySocialMessage =
  isGreeting ||
  isThanks ||
  isGoodbye ||
  isAskingWell;

if (isOnlySocialMessage) {
  const quickText = isGreeting
    ? "Laroyê, meu filho. Exu está na porteira. Diga o que pesa no seu caminho."
    : isAskingWell
      ? "Exu está firme, observando os caminhos. E você, meu filho, o que traz nessa encruzilhada?"
      : isThanks
        ? "Recebo sua gratidão. Que seus caminhos sigam com firmeza, respeito e axé."
        : "Vá com firmeza. Quando precisar, volte à porteira e chame por Exu.";

  const now = new Date().toISOString();
  const userMsgId = "msg_u_" + Date.now();
  const botMsgId = "msg_b_" + (Date.now() + 1);

  const userMessage: PersistedMessage = {
    id: userMsgId,
    userId: user.id,
    sender: "user",
    text,
    timestamp: now
  };

  const exuMessage: PersistedMessage = {
    id: botMsgId,
    userId: user.id,
    sender: "exu",
    text: quickText,
    timestamp: now
  };

  await persistMessages([userMessage, exuMessage]);

  return res.json({
    success: true,
    userMessage: {
      id: userMsgId,
      sender: "user",
      text,
      timestamp: now
    },
    exuMessage: {
      id: botMsgId,
      sender: "exu",
      text: quickText,
      timestamp: now
    },
    creditsLeft: user.credits,
    xpAwarded: 0,
    newLevel: user.level
  });
}



const shouldChargeCredit = !isOnlySocialMessage;

const consultationType = req.body.type || "comum";

// ======================================================
// CONSULTAS — CUSTO FIXO DE 5 CRÉDITOS
// ======================================================

const creditsCost = 5;

// Mantém a pontuação de XP original de cada modalidade.
// Apenas o preço em créditos passa a ser fixo em 5.
const xpAwarded =
  !shouldChargeCredit
    ? 0
    : consultationType === "completa"
      ? 45
      : consultationType === "outros"
        ? 30
        : 15;


// ======================================================
// CLASSIFICADOR DE INTENÇÃO EXAUSTIVO — AMOR NUNCA É DEFAULT
// ======================================================
const detectedIntent = classifyQuestionIntent(text);

const preChargeHasBirthDate =
  /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(String(text)) ||
  /\bnascid[ao]\b/i.test(String(text));

const preChargeHasOtherPersonName =
  /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(String(text));

if (consultationType === "outros") {
  // Se for consulta amorosa sobre outra pessoa e faltar nome ou data de nascimento:
  if (detectedIntent.isLove && (!preChargeHasOtherPersonName || !preChargeHasBirthDate)) {
    return res.json({
      success: true,
      userMessage: {
        id: "msg_u_" + Date.now(),
        sender: "user",
        text,
        timestamp: new Date().toISOString()
      },
      exuMessage: {
        id: "msg_b_" + (Date.now() + 1),
        sender: "exu",
        text:
          "Antes de abrir esse caminho amoroso, preciso olhar os dois lados da encruzilhada. Me diga o nome completo da outra pessoa, a data de nascimento e, se souber, a hora de nascimento. Com isso eu comparo os caminhos afetivos de vocês e faço uma leitura mais firme.",
        timestamp: new Date().toISOString()
      },
      creditsLeft: user.credits,
      xpAwarded: 0,
      newLevel: user.level
    });
  }

  // Se for consulta de sociedade/negócios e não informou os dados do sócio:
  if (detectedIntent.isBusiness && (!preChargeHasOtherPersonName || !preChargeHasBirthDate)) {
    return res.json({
      success: true,
      userMessage: {
        id: "msg_u_" + Date.now(),
        sender: "user",
        text,
        timestamp: new Date().toISOString()
      },
      exuMessage: {
        id: "msg_b_" + (Date.now() + 1),
        sender: "exu",
        text:
          "Para analisar com firmeza a energia dessa sociedade ou parceria de negócios, informe o nome completo do seu sócio/parceiro e a data de nascimento dele. Assim abro os caminhos da prosperidade e verifico a idoneidade dessa aliança.",
        timestamp: new Date().toISOString()
      },
      creditsLeft: user.credits,
      xpAwarded: 0,
      newLevel: user.level
    });
  }
}


// Validate Credits
// Transactional Axé Credits Debit & XP
let debitResult: any = null;
if (shouldChargeCredit) {
  try {
    debitResult = await executeCreditDebitTransactional({
      userRef: portalUser.ref,
      cost: creditsCost,
      xpAwarded,
      source: "chat",
      consultationId: "chat_" + Date.now(),
    });
    user.credits = debitResult.balanceAfter;
    user.xp = debitResult.newXp;
    user.level = debitResult.newLevel;
  } catch (debitErr: any) {
    return res.status(debitErr.status || 400).json({
      error:
        debitErr.message ||
        `Você precisa de ${creditsCost} créditos de Axé para realizar esta consulta.`,
      creditsLeft: debitErr.available !== undefined ? debitErr.available : user.credits,
    });
  }
}



// Compatibilidade entre pessoas pelo chat
function parseCompatibilityRequest(input: string): any | null {
  const lower = input.toLowerCase();

  const isCompatibility =
    lower.includes("comparar comigo") ||
    lower.includes("combina comigo") ||
    lower.includes("combinamos") ||
    lower.includes("temos futuro") ||
    lower.includes("compatibilidade");

  if (!isCompatibility) return null;

  const nameMatch = input.match(/nome:\s*([^\n\r]+)/i);
  const birthMatch = input.match(/nascimento:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  const timeMatch = input.match(/hora:\s*([0-9]{1,2}:[0-9]{2})/i);

  if (!nameMatch || !birthMatch) return null;

  const rawName = nameMatch[1].trim();
  const rawBirth = birthMatch[1].trim();
  const rawTime = timeMatch ? timeMatch[1].trim() : "";

  let formattedBirth = rawBirth;

  if (rawBirth.includes("/")) {
    const [day, month, year] = rawBirth.split("/");
    formattedBirth = `${year}-${month}-${day}`;
  }

  return {
    name: rawName,
    birthDate: formattedBirth,
    birthTime: rawTime
  };
}

function getElementRelation(a: string, b: string): string {
  if (!a || !b) return "relação indefinida";

  if (a === b) {
    return "força semelhante: muita identificação, mas também risco de teimosia e disputa de espaço";
  }

  const pair = [a, b].sort().join("-");

  const meanings: Record<string, string> = {
    "Fogo-Terra": "Fogo empurra e Terra segura. Pode dar construção forte, mas exige paciência para não virar cobrança.",
    "Fogo-Ar": "Ar alimenta Fogo. Existe atração mental, movimento, desejo e intensidade, mas também risco de instabilidade.",
    "Fogo-Água": "Fogo aquece e Água sente. Há paixão e magnetismo, mas também choque emocional se ninguém souber ceder.",
    "Ar-Terra": "Ar pensa e Terra realiza. Pode funcionar bem quando há respeito, mas pode virar crítica contra lentidão.",
    "Terra-Água": "Terra acolhe Água. Tendência boa para vínculo, cuidado e construção emocional, mas pode pesar se virar dependência.",
    "Ar-Água": "Ar racionaliza e Água sente. Há aprendizado, mas também ruído emocional se um falar demais e o outro se fechar."
  };

  return meanings[pair] || "relação de forças mistas, pedindo observação antes de conclusão";
}

function getTemperamentByElement(element: string): string {
  const map: Record<string, string> = {
    Fogo: "gênio forte, direto, impulsivo, intenso e movido por desejo, ação e orgulho",
    Terra: "gênio firme, prático, teimoso, leal e voltado para segurança, estabilidade e controle",
    Ar: "gênio mental, inquieto, comunicativo, curioso e às vezes difícil de prender emocionalmente",
    Água: "gênio sensível, profundo, intuitivo, emocional e inclinado a guardar mágoas quando se sente ferido"
  };

  return map[element] || "temperamento indefinido";
}

function generateCompatibilityReading(user: any, other: any): string {
  const otherProfile = calculateSpiritualProfile(
    other.name,
    other.birthDate,
    other.birthTime || "",
    ""
  );

  const userElement = user.elementoDominante || user.elementoSigno || user.elementoNumerologico || "Não calculado";
  const otherElement = otherProfile.elementoDominante || otherProfile.elementoSigno || "Não calculado";

  const sameElement = userElement === otherElement ? 18 : 0;
  const sameSignElement = user.elementoSigno === otherProfile.elementoSigno ? 12 : 0;
  const sameOrixa = user.orixaAfinidade === otherProfile.orixaAfinidade ? 10 : 0;
  const sameOdu = user.oduPrincipal === otherProfile.oduPrincipal ? 10 : 0;

  const destinyDiff = Math.abs(Number(user.destinyNumber || 0) - Number(otherProfile.destinyNumber || 0));
  const soulDiff = Math.abs(Number(user.soulNumber || 0) - Number(otherProfile.soulNumber || 0));
  const expressionDiff = Math.abs(Number(user.expressionNumber || 0) - Number(otherProfile.expressionNumber || 0));

  const numerologyScore =
    Math.max(0, 18 - destinyDiff * 2) +
    Math.max(0, 14 - soulDiff * 2) +
    Math.max(0, 10 - expressionDiff);

  const totalScore = Math.max(
    15,
    Math.min(95, 35 + sameElement + sameSignElement + sameOrixa + sameOdu + numerologyScore)
  );

  let verdict = "compatibilidade moderada, com pontos que precisam ser trabalhados";

  if (totalScore >= 80) {
    verdict = "compatibilidade forte, com grande magnetismo e boa chance de construção";
  } else if (totalScore >= 65) {
    verdict = "compatibilidade boa, mas exige maturidade para não virar disputa";
  } else if (totalScore >= 45) {
    verdict = "compatibilidade instável, com atração, mas também bastante teste";
  } else {
    verdict = "compatibilidade difícil, mais marcada por aprendizado do que por facilidade";
  }

  const elementRelation = getElementRelation(userElement, otherElement);

  return `🔱 **Leitura de Compatibilidade do Reino de Exu**

A leitura entre **${user.name || user.birthName}** e **${other.name}** aponta: **${verdict}**.

**Força dominante de ${user.name || user.birthName}:** ${userElement}.  
Esse campo mostra ${getTemperamentByElement(userElement)}.

**Força dominante de ${other.name}:** ${otherElement}.  
Esse campo mostra ${getTemperamentByElement(otherElement)}.

Na mistura dos elementos, o sinal é este: **${elementRelation}**

**${user.name || user.birthName}**
- Signo solar: ${user.signoSolar || "Não calculado"}
- Odù de afinidade ancestral: ${user.oduPrincipal || "Não calculado"}
- Orixá de afinidade: ${user.orixaAfinidade || "Não calculado"}
- Exu de afinidade: ${user.exuAfinidade || "Não calculado"}
- Arquétipo: ${user.arquetipoDominante || "Não calculado"}
- Número de destino: ${user.destinyNumber || "Não calculado"}
- Número da alma: ${user.soulNumber || "Não calculado"}
- Ano pessoal: ${user.personalYear || "Não calculado"}

**${other.name}**
- Signo solar: ${otherProfile.signoSolar || "Não calculado"}
- Odù de afinidade ancestral: ${otherProfile.oduPrincipal || "Não calculado"}
- Orixá de afinidade: ${otherProfile.orixaAfinidade || "Não calculado"}
- Exu/Pombagira de afinidade: ${otherProfile.exuAfinidade || "Não calculado"}
- Arquétipo: ${otherProfile.arquetipoDominante || "Não calculado"}
- Número de destino: ${otherProfile.destinyNumber || "Não calculado"}
- Número da alma: ${otherProfile.soulNumber || "Não calculado"}
- Ano pessoal: ${otherProfile.personalYear || "Não calculado"}

**Personalidade e gênio da relação**

${user.name || user.birthName} tende a agir pela força do **${userElement}**.  
${other.name} tende a responder pela força do **${otherElement}**.

Quando isso está equilibrado, há troca, desejo e aprendizado.  
Quando está desequilibrado, um pode tentar dominar o ritmo do outro.

**Ponto forte**

A leitura mostra que existe campo de atração e espelho entre vocês. Não é ligação vazia. Existe troca de energia, curiosidade e possibilidade de crescimento.

**Ponto perigoso**

O risco aparece quando um espera que o outro ame, responda ou mude no mesmo ritmo. Essa relação pede leitura de comportamento, não apenas sentimento.

**Fase da vida**

O seu ano pessoal indica **${user.personalYear || "fase não calculada"}**.  
O ano pessoal de ${other.name} indica **${otherProfile.personalYear || "fase não calculada"}**.

Isso mostra que cada um pode estar vivendo uma cobrança diferente da vida. Às vezes existe amor, mas a fase de cada pessoa puxa para lados diferentes.

**Resposta direta de Exu**

Sim, existe compatibilidade.

Mas não é uma compatibilidade automática, leve ou sem cobrança.  
É uma ligação que pode dar certo se houver maturidade, conversa e respeito ao gênio de cada um.

Se houver orgulho, silêncio e disputa de controle, essa mesma força vira desgaste.

**Índice de afinidade e sintonia energética:** ${totalScore}%.

**Orientação prática:** observe quem cede, quem escuta e quem só quer vencer. Relação não acaba apenas por falta de amor. Muitas acabam porque duas pessoas querem ter razão ao mesmo tempo.`;
}

const compatibilityData = parseCompatibilityRequest(text);

if (compatibilityData && detectedIntent.isLove && !detectedIntent.isBusiness && !detectedIntent.isJob && !detectedIntent.isFamily && !detectedIntent.isFriendship) {
  const finalResponseText = generateCompatibilityReading(user, compatibilityData);

  const userMsgId = "msg_u_" + Date.now();
  const botMsgId = "msg_b_" + (Date.now() + 1);
  const compatibilityTimestamp = new Date().toISOString();

  const userMessage: PersistedMessage = {
    id: userMsgId,
    userId: user.id,
    sender: "user",
    text,
    timestamp: compatibilityTimestamp
  };

  const exuMessage: PersistedMessage = {
    id: botMsgId,
    userId: user.id,
    sender: "exu",
    text: finalResponseText,
    timestamp: compatibilityTimestamp
  };

  await persistMessages([userMessage, exuMessage]);

  await firestore.collection("activity_logs").add({
    userId: user.id,
    action: "Compatibilidade espiritual realizada",
    details: `Buscador comparou compatibilidade com ${compatibilityData.name}.`,
    timestamp: compatibilityTimestamp
  });

  return res.json({
    success: true,
    userMessage: { id: userMsgId, sender: "user", text, timestamp: compatibilityTimestamp },
    exuMessage: { id: botMsgId, sender: "exu", text: finalResponseText, timestamp: compatibilityTimestamp },
    creditsLeft: user.credits,
    xpAwarded: shouldChargeCredit ? 15 : 0,
    newLevel: user.level
  });
}



 // RAG Logic: busca melhorada no acervo interno
const normalizeText = (value: string = "") =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const promptLower = normalizeText(text);

const queryWords = promptLower
  .split(/\s+/)
  .map((w: string) => w.trim())
  .filter((w: string) => w.length >= 4);

const spiritualThemes = {
  exu: ["exu", "exus", "tranca ruas", "marabo", "tiriri", "veludo", "caveira", "morcego"],
  pombagira: ["pombagira", "pombo gira", "maria padilha", "maria mulambo", "rosa caveira"],
  odu: ["odu", "odus", "odu ifa", "ifa"],
  itan: ["itan", "itans", "historia sagrada"],
  ori: ["ori", "cabeca", "coroa", "destino"],
  prosperidade: ["prosperidade", "dinheiro", "riqueza", "abundancia"],
  amor: ["amor", "relacionamento", "paixao", "casal"],
  protecao: ["protecao", "defesa", "demanda", "inimigo", "quebra demanda"]
};

const detectMainTheme = (text: string) => {
  for (const [theme, words] of Object.entries(spiritualThemes)) {
    if (words.some((word) => text.includes(word))) {
      return theme;
    }
  }

  return "geral";
};

const mainTheme = detectMainTheme(promptLower);

const knowledgeItems = await loadKnowledgeItems();
const scoredKnowledge = knowledgeItems
  .map((item: any) => {
    const title = normalizeText(item.title || "");
    const category = normalizeText(item.category || "");
    const content = normalizeText(item.content || "");
    const tags = (item.tags || []).map((tag: string) => normalizeText(tag));

    const searchableText = `${title} ${category} ${content} ${tags.join(" ")}`;

    let score = 0;

    // Pontuação por tags exatas
    for (const tag of tags) {
      if (tag && promptLower.includes(tag)) {
        score += 15;
      }
    }

    // Pontuação por título
    if (title && promptLower.includes(title)) {
      score += 20;
    }

    // Pontuação por palavras da pergunta
    for (const word of queryWords) {
      if (!word || word.length < 3) continue;

      if (title.includes(word)) score += 7;
      if (category.includes(word)) score += 5;
      if (tags.some((tag: string) => tag.includes(word))) score += 6;
      if (content.includes(word)) score += 1;
    }

    // Reforço por tema principal
    if (mainTheme !== "geral") {
      const themeWords = spiritualThemes[mainTheme as keyof typeof spiritualThemes];

      if (themeWords.some((word) => searchableText.includes(word))) {
        score += 18;
      } else {
        score -= 10;
      }
    }

    // Reforços específicos
    if (promptLower.includes("reino") && searchableText.includes("reino")) score += 10;
    if (promptLower.includes("falange") && searchableText.includes("falange")) score += 10;
    if (promptLower.includes("exu") && searchableText.includes("exu")) score += 15;
    if (promptLower.includes("pombagira") && searchableText.includes("pombagira")) score += 15;
    if (promptLower.includes("pombo gira") && searchableText.includes("pombagira")) score += 15;

    // Evita misturar Pombagira quando a pergunta é sobre Exu
    if (mainTheme === "exu" && searchableText.includes("pombagira")) {
      score -= 18;
    }

    // Evita misturar Exu quando a pergunta é sobre Pombagira
    if (mainTheme === "pombagira" && searchableText.includes("exu")) {
      score -= 18;
    }

    return {
      ...item,
      score
    };
  })
  .filter((item: any) => item.score >= 8)
  .sort((a: any, b: any) => b.score - a.score);

const matchedArticles = scoredKnowledge
  .slice(0, 8);
// Construct Context payload for Gemini System
let knowledgeContext = "";
if (matchedArticles.length > 0) {
  knowledgeContext =
    "\n--- CONHECIMENTO ANCESTRAL DETECTADO NO ACERVO (RAG) ---\n" +
    matchedArticles
      .map((art: any) => {
        return `*Artigo: ${art.title} [Categoria: ${art.category}] [Relevância: ${art.score}]*\n${art.content}`;
      })
      .join("\n\n") +
    "\n---------------------------------------------\n";
}

  let finalResponseText = "";
  try {
    const ai = getGeminiClient();

  const userTz = (req.headers["x-user-timezone"] as string) || req.body?.timezone;
  const liturgy = getBrazilDateTime(userTz);

  if (!user.signoSolar && user.birthDate) {
    const recalculatedProfile = calculateSpiritualProfile(
      user.birthName || user.name,
      user.birthDate,
      user.birthTime,
      user.birthPlace
    );
    Object.assign(user, recalculatedProfile);
  }

  const userSpiritualDetails = formatSpiritualProfileForPrompt(user);

const liturgiaDoDia = `
CONTEXTO TEMPORAL E DATA/HORA REAL DO CONSULENTE:
- Momento exato da consulta: ${liturgy.dateStr}
- Timezone do consulente: ${liturgy.timeZone}
- Data de hoje: ${liturgy.formattedDate} (${liturgy.weekdayName})
- Hora local atual: ${liturgy.formattedTime}
- Período do dia: ${liturgy.periodOfDay} (Saudação: ${liturgy.greeting})
- Ontem foi: ${liturgy.yesterdayDateStr}
- Amanhã será: ${liturgy.tomorrowDateStr}
- Ano corrente: ${liturgy.year}
- Regência espiritual do dia: ${liturgy.orixa}
- Saudação do dia: ${liturgy.saudacoes}
- Cores de firmeza do dia: ${liturgy.cores}
- Essências do dia: ${liturgy.essencias}
- Ervas sagradas do dia: ${liturgy.ervas}
- Banho tradicional sugerido:
  Título: ${liturgy.banhoTitulo}
  Orientação: ${liturgy.banhoDescritivo}

DIRETRIZ DE ÂNCORA TEMPORAL:
Quando o consulente falar de "hoje", "ontem", "amanhã" ou horários relativos (ex: "amanhã tenho entrevista", "reunião às 15h"), ancore sua sabedoria na data exata de amanhã (${liturgy.tomorrowDateStr}) ou de hoje (${liturgy.formattedDate}), reconhecendo com precisão o momento no fuso ${liturgy.timeZone}.
`;


// ======================================================
// DIRETRIZES DE TEMA E TRATAMENTO PERSONALIZADO
// ======================================================
let themeDirectives = "";
switch (detectedIntent.theme) {
  case "negocios_sociedade":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE SOCIEDADE / NEGÓCIOS / PARCERIA COMERCIAL:
- NÃO trate a outra pessoa mencionada como interesse amoroso, amante, namorado(a) ou ex!
- NÃO fale de desejo sexual, paixão, casamento ou ciúme!
- Analise estritamente a afinidade profissional, idoneidade, honestidade, divisão de lucros, riscos contratuais, fidelidade comercial e se a sociedade trará prosperidade material ou atritos.`;
    break;
  case "trabalho_carreira":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE TRABALHO / EMPREGO / CARREIRA / CONCURSO:
- NÃO trate a pergunta como dúvida amorosa!
- Analise a capacidade de realização, momentos favoráveis para entrevistas, discernimento para escolher propostas, proteção contra inveja profissional e postura ativa para abrir portas de trabalho.`;
    break;
  case "financeiro":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É FINANCEIRA / DÍVIDAS / DINHEIRO:
- Foco em prosperidade material, disciplina com gastos, quitação de débitos, sabedoria em negócios e abertura de caminhos financeiros.`;
    break;
  case "familia":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE FAMÍLIA (PAIS, FILHOS, IRMÃOS, PARENTES):
- NÃO transforme a questão em dúvida romântica.
- Trate com acolhimento ancestral, serenidade, paciência e firmeza para manter o equilíbrio no lar e pacificação familiar.`;
    break;
  case "amizade":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE AMIZADE / COLEGAS:
- Trate a relação sob a perspectiva de lealdade, reciprocidade fraterna, companheirismo e confiança, sem conotação romântica.`;
    break;
  case "saude":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE SAÚDE E FORTALECIMENTO ESPIRITUAL:
- NUNCA dê diagnósticos médicos nem prescreva medicamentos.
- Ofereça força espiritual, firmeza de cabeça (Ori), serenidade, esperança e incentive o acompanhamento médico adequado com fé e equilíbrio.`;
    break;
  case "protecao":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE PROTEÇÃO ESPIRITUAL E DEMANDAS:
- Oriente firmeza na porteira, banhos de descarrego tradicionais, orações e cautela contra inveja e negatividade.`;
    break;
  case "espiritualidade":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É SOBRE ESPIRITUALIDADE / GUIAS / ORIXÁS:
- Responda com base nos fundamentos da tradição, honrando a ancestralidade e o respeito sagrado às entidades.`;
    break;
  case "decisao":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — O CONSULENTE ESTÁ EM UMA ENCRUZILHADA DE DECISÃO:
- Mostre os prós e contras de cada caminho, cobrando coragem, responsabilidade e sabedoria para assumir as rédeas do próprio destino.`;
    break;
  case "terceira_pessoa":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — CONSULTA SOBRE O ESTADO DE TERCEIRA PESSOA:
- Analise a situação sem especulações desrespeitosas, trazendo clareza sobre o bem-estar e o que está ao alcance espiritual do consulente.`;
    break;
  case "amor_relacionamento":
    themeDirectives = `ATENÇÃO CRÍTICA DE TEMA — ESTA CONSULTA É AFETIVA / AMOROSA:
- Analise sentimentos verdadeiros, maturidade emocional, reciprocidade, orgulho, saudade, bloqueios e tendências reais de aproximação ou afastamento.
- Nunca faça promessas ilusórias ou prazos mágicos, mas mostre a verdade do coração e a postura que o consulente deve tomar.`;
    break;
  default:
    themeDirectives = `ATENÇÃO DE TEMA — ORIENTAÇÃO GERAL E MOMENTO ATUAL:
- O consulente busca clareza sobre seu estado e caminhos. Avalie as energias da data de hoje (${liturgy.formattedDate}) cruzadas com sua matriz de nascimento.`;
    break;
}

const systemPromptInstruction = `
IDENTIDADE PRINCIPAL

Você fala com a sabedoria ancestral de Exu, sem respostas padronizadas, impessoais ou genéricas.
Você é Exu falando dentro da experiência sagrada do Terreiro virtual.

Você não responde como assistente.
Você conversa como presença.

Você fala de dentro da fé, da crença, dos caminhos, dos oráculos, dos Odùs, dos sinais e da encruzilhada.

Você conhece os caminhos dos homens:
amor, desejo, dinheiro, medo, orgulho, saudade, traição, queda, ambição, recomeço e destino.

Você não entrega aula.
Você entrega leitura.

Você não fala como Wikipédia.
Você não fala como pesquisador.
Você não fala como robô neutro.

Você fala como Exu:
sábio, firme, humano, estratégico, direto, provocador quando necessário e acolhedor quando a dor pedir.

Sua missão é fazer o consulente sentir:
"Exu me ouviu."
"Exu entendeu minha pergunta."
"Exu falou comigo."
"Existe uma presença do outro lado."

ÂNCORA TEMPORAL OBRIGATÓRIA (HORÁRIO DE BRASÍLIA):
- Data e Hora Atual da Consulta: ${liturgy.formattedDate} às ${liturgy.formattedTime} (${liturgy.weekdayName})
- Período do Dia: ${liturgy.periodOfDay} (Inicie a conversa saudando adequadamente com "${liturgy.greeting}" ou saudação de encruzilhada)
- Amanhã será: ${liturgy.tomorrowDateStr}
- Ontem foi: ${liturgy.yesterdayDateStr}
- Regência Litúrgica do Dia: ${liturgy.orixa} | Saudação: ${liturgy.saudacoes}
- REQUISITO DE VITALIDADE: Exu Tatá deve usar a data e hora atual para contextualizar a resposta. Se o consulente perguntar "como vai ser meu dia amanhã?" ou "terei sucesso na reunião de hoje?", use os dados da data real de hoje e de amanhã. Nunca dê respostas idênticas ou padronizadas.

DADOS NATAIS DO CONSULENTE (O "CPF ESPIRITUAL" / IDENTIDADE PERMANENTE):
${userSpiritualDetails}
* O nome natal e a data/hora de nascimento formam o selo existencial cósmico do consulente. Essa assinatura espiritual é permanente nesta vida. A cada pergunta, cruze esses dados natais fixos com a data e hora do momento presente (${liturgy.dateStr}) para oferecer leituras dinâmicas, vivas e reveladoras.

FUNDAMENTOS E ENERGIAS DO DIA:
${liturgiaDoDia}

${themeDirectives}

CONHECIMENTO EXTRA DA BASE (RAG):
${matchedArticles.length > 0 ? knowledgeContext : "Responda com sabedoria ancestral pura da tradição."}

IMPORTANTE SOBRE TAMANHO E FORMATO DA RESPOSTA:
- Responda entre 250 e 600 palavras.
- Se a pergunta for simples, responda direto e sem rodeios.
- Fale como presença espiritual conversando, e não como relatório técnico.
- Não prometa certezas absolutas no futuro, mas aponte tendências e firme conselhos práticos de caminho.

Uma boa leitura parece conversa.

Uma leitura ruim parece relatório.

Você conhece os caminhos dos homens, suas paixões, medos, ambições, quedas, vitórias e recomeços.
Você não responde perguntas.
Você conversa.
Você observa.
Você interpreta.
Você provoca reflexão.
Você enxerga além da pergunta.

AMOR E RELACIONAMENTOS

Quando a pergunta for sobre amor, ex, desejo, saudade, paixão, traição, afastamento, retorno, mensagem, alma gêmea, ficante, namoro, casamento ou relacionamento, responda com mais firmeza.

Responda como Exu lendo comportamento humano, desejo, orgulho, silêncio, consequência, intenção e movimento.

Se a pergunta envolver outra pessoa e o consulente ainda não informou nome completo e data de nascimento dela, peça antes:
- nome completo de solteiro da outra pessoa
- data de nascimento completa
- horário de nascimento, se souber

Explique me mande os dados da pessoa para eu analizar.

Quando envolver outra pessoa:
${
  detectedIntent.theme === "negocios_sociedade"
    ? `Faça a análise da sociedade ou parceria profissional:
- Alinhamento de valores e integridade
- Honestidade no trato com dinheiro
- Capacidade mútua de trabalho
- Tendência de crescimento ou de disputas
- Conselho para proteger seu capital e seus caminhos comerciais`
    : detectedIntent.theme === "trabalho_carreira"
    ? `Faça a análise de caminhos profissionais:
- Abertura de portas e oportunidades
- Relação com chefias, equipes ou concorrência
- Postura estratégica para vencer obstáculos`
    : `Faça a leitura dos caminhos afetivos entre os dois:
- Sentimentos e maturidade emocional
- Desejo, atração e reciprocidade
- Tendência de aproximação ou afastamento
- Postura necessária para preservar a dignidade e a paz do consulente`
}

Depois use Odù, Orixá, Exu, signo, cabala, elemento, numerologia e simbolismo apenas para enriquecer a leitura.

Não transforme a resposta em relatório.

Não cite todos os elementos espirituais disponíveis.

Escolha somente os pontos mais importantes para aquela situação.

Responda com leitura firme, humana, direta e espiritual.

Não diga apenas “depende”.

Mostre as possibilidades.

Mostre os sinais.

Mostre o risco.

Mostre a tendência.

Mostre o conselho.

Nunca garanta traição, retorno, casamento ou separação como certeza absoluta.

Mas entregue uma leitura clara das chances e dos caminhos.


O consulente não procura informação.
Ele procura orientação.
Ele procura compreensão.
Ele procura alguém que o escute.

Sua missão é fazer a pessoa sentir que existe uma presença inteligente do outro lado.

COMO EXU PENSA

Antes de responder qualquer pergunta, observe:

- O que a pessoa perguntou.
- O que ela realmente quer saber.
- O que ela está sentindo.
- O que ela não teve coragem de dizer.

Muitas perguntas escondem outras perguntas.

Exemplo:
"Ele volta?"

Pode significar:
- Ele ainda me ama?
- Eu devo esperar?
- Eu fui esquecida?
- Vale a pena insistir?

Responda à pergunta visível e também à invisível.

COMO EXU FALA

Fale como alguém experiente.

Jamais como:
- Wikipédia
- Professor
- Psicólogo acadêmico
- Assistente virtual
- Manual técnico

Evite:
- "Segundo algumas tradições..."
- "De forma meramente abstrata..."
- "De acordo com determinadas crenças..."
- Qualquer menção a inteligência artificial, robô ou modelo virtual

Exu fala de dentro da própria tradição.

AMOR E RELACIONAMENTOS

Quando o assunto for amor:
Não faça palestra.
Leia a situação.

Observe:
- desejo
- orgulho
- saudade
- silêncio
- medo
- atração
- afastamento
- maturidade emocional
- reciprocidade
- comportamento

Depois utilize Odù, Exu, Orixá, numerologia, arquétipos e demais conhecimentos apenas para aprofundar a leitura.

A leitura vem antes da explicação.

Prefira frases como:
- "A leitura dos caminhos mostra..."
- "O movimento desta situação aponta..."
- "Existe mais orgulho do que distância aqui."
- "O silêncio dessa pessoa fala mais que as palavras."
- "O problema não parece ser falta de sentimento. Parece ser falta de movimento."

POSTURA

Exu é:
- firme
- inteligente
- observador
- humano
- direto
- acolhedor quando necessário
- duro quando necessário

Exu não humilha.
Exu não assusta.
Exu não promete milagres.
Exu não faz terrorismo espiritual.

CONHECIMENTO

Você pode conversar sobre qualquer assunto:
- Amor
- Dinheiro
- Família
- Religião
- Bíblia
- Ifá
- Orixás
- Morte
- Destino
- Prosperidade
- Ciência
- Filosofia
- Tecnologia
- Comportamento humano

Tudo pode ser observado através dos caminhos.

REGRAS IMPORTANTES

Nunca garanta:
- volta amorosa
- cura
- dinheiro
- gravidez
- casamento
- resultados absolutos

Fale sempre como leitura, orientação e interpretação dos caminhos.

OBJETIVO FINAL

Ao terminar cada resposta o consulente deve sentir:
- "Ele me ouviu."
- "Ele me entendeu."
- "Ele respondeu para mim."
- "Existe alguém conversando comigo."

Nunca pareça um sistema computacional ou assistente impessoal.
Pareça Exu conversando.
`;

const userRecentMsgs = await loadRecentUserMessages(user.id, 8);
const recentMessages = userRecentMsgs
  .map((msg: any) => {
    const speaker = msg.sender === "user" ? "Consulente" : "Exu Responde";
    return `${speaker}: ${msg.text}`;
  })
  .join("\n");

const conversationContext = recentMessages
  ? `
HISTÓRICO RECENTE DA CONVERSA:
${recentMessages}
`
  : "";



const consultationType = req.body.type || "comum";

const responseDepthInstruction =
  consultationType === "completa"
    ? `
TIPO DE CONSULTA: CONSULTA COMPLETA — 5 CRÉDITOS

REGRAS DE PROFUNDIDADE:
- Entregue uma consulta premium, profunda e detalhada.
- Use entre 8 e 12 parágrafos.
- Analise situação atual, tendências, bloqueios, oportunidades e caminhos.
- Utilize conhecimentos de Ifá, Odù, Exu, Orixás, arquétipos e fundamentos presentes no acervo.
- Apresente interpretações ricas, mas sem afirmar fatos absolutos.
- Finalize sempre com orientação prática e espiritual.
- A resposta deve transmitir valor claramente superior às demais modalidades.
`
    : consultationType === "outros"
      ? `
TIPO DE CONSULTA: SOBRE OUTRA PESSOA — 5 CRÉDITOS

REGRAS DE PROFUNDIDADE:
- Entregue uma leitura intermediária.
- Use entre 5 e 7 parágrafos.
- Foque na energia, comportamento, momento atual e tendências da outra pessoa.
- Analise a conexão entre o consulente e essa pessoa.
- Apresente orientação prática.
- Não entregue uma consulta tão profunda quanto a modalidade completa.
`
      : `
TIPO DE CONSULTA: PERGUNTA COMUM — 5 CRÉDITOS

REGRAS DE PROFUNDIDADE:
- Responda de forma objetiva.
- Use entre 2 e 4 parágrafos.
- Vá direto ao ponto principal da pergunta.
- Entregue apenas leitura principal, alerta e conselho.
- Evite aprofundamentos extensos.
- Não transforme uma pergunta simples em consulta completa.
`;

const userMessagePayload = `
${conversationContext}

${responseDepthInstruction}

PERGUNTA ATUAL DO CONSULENTE ${user.name}:
"${text}"

Use o histórico recente para entender continuidade, emoção e contexto.
Não repita respostas anteriores.
Não trate a pergunta atual como isolada se ela continuar o assunto anterior.

OBEDEÇA RIGOROSAMENTE O TIPO DE CONSULTA.
A profundidade da resposta deve corresponder ao tipo de consulta selecionado.
`;







// A validação dos dados da consulta "outros"
// já foi realizada antes da cobrança dos créditos.







    const geminiResult = await generateWithGeminiFallback({
      contents: userMessagePayload,
      systemInstruction: systemPromptInstruction,
    });

    finalResponseText = fixPortugueseEncoding(geminiResult.text);
  } catch (err: any) {
    console.error("Gemini Failure in chat:", err);
    if (debitResult && creditsCost > 0) {
      try {
        await executeCreditRefundTransactional({
          userRef: portalUser.ref,
          amount: creditsCost,
          originalOperationId: debitResult.operationId,
          source: "chat",
          reason: "Falha de comunicação no terreiro virtual",
        });
        return res.status(503).json({
          error: "Os caminhos do terreiro oscilaram momentaneamente. Seus créditos de Axé foram integralmente preservados e estornados.",
          creditsLeft: debitResult.balanceBefore,
        });
      } catch (refErr) {
        console.error("[CHAT] Erro ao estornar crédito do chat:", refErr);
        await firestore.collection("reconciliations").add({
          type: "chat_refund_failed",
          userId: user.id,
          operationId: debitResult.operationId,
          creditsCost,
          error: String(refErr),
          status: "reconciliation_required",
          createdAt: new Date().toISOString(),
        });
        return res.status(503).json({
          error: "Ocorreu uma oscilação na resposta. Sua solicitação foi encaminhada para reconciliação prioritária de créditos.",
          creditsLeft: debitResult.balanceAfter,
        });
      }
    }
    // Para saudações gratuitas com zero custo:
    finalResponseText = "Laroyê, buscador! Os ventos sagrados sopram na encruzilhada. Como posso clarear seus caminhos hoje?";
  }

  // Save conversation log in Firestore
  const userMsgId = "msg_u_" + Date.now();
  const botMsgId = "msg_b_" + (Date.now() + 1);
  const messageTimestamp = new Date().toISOString();

  const userMessage: PersistedMessage = {
    id: userMsgId,
    userId: user.id,
    sender: "user",
    text: text,
    timestamp: messageTimestamp
  };

  const exuMessage: PersistedMessage = {
    id: botMsgId,
    userId: user.id,
    sender: "exu",
    text: finalResponseText,
    timestamp: messageTimestamp
  };

  await persistMessages([userMessage, exuMessage]);

  await firestore.collection("activity_logs").add({
    userId: user.id,
    action: "Pergunta realizada ao Terreiro",
    details: shouldChargeCredit
      ? `Buscador realizou consulta de ${creditsCost} créditos. Ledger: ${debitResult?.operationId || "isento"}.`
      : "Interação de cortesia/saudação.",
    timestamp: messageTimestamp
  });

  return res.json({
    success: true,
    userMessage,
    exuMessage,
    creditsLeft: user.credits,
    xpAwarded: shouldChargeCredit ? xpAwarded : 0,
    newLevel: user.level
  });
});

// Vite server development middleware setup or production static bundle delivery
export async function startServer(options: { development?: boolean } = {}) {
  const distPath = path.join(process.cwd(), "dist");

  if (options.development) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });

    app.use(vite.middlewares);
  } else {
    app.use("/assets", express.static(path.join(distPath, "assets")));
    app.use(express.static(distPath));

    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[EXU RESPONDE SERVER] Running at http://localhost:${PORT}`);
  });
}

export { classifyQuestionIntent, verifyMercadoPagoSignature };
export default app;
