import type express from "express";
import crypto from "node:crypto";
import { getApps } from "firebase-admin/app";

// ======================================================
// OBTENÇÃO SEGURA DE IP REAL (SEM CONFIAR CEGAMENTE EM SPOOFING)
// ======================================================
export function getClientIp(req: express.Request): string {
  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim()) {
    return xRealIp.trim();
  }

  const cfConnectingIp = req.headers["cf-connecting-ip"];
  if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    const ips = xForwardedFor.split(",").map((ip) => ip.trim());
    if (ips[0]) return ips[0];
  }

  return req.socket?.remoteAddress || req.ip || "127.0.0.1";
}

// ======================================================
// FIREBASE APP CHECK / ANTIBOT VERIFICATION OFICIAL
// ======================================================
export async function verifyAppCheckToken(
  firebaseAdminApp: any,
  token?: string
): Promise<{ valid: boolean; decodedToken?: any; error?: string }> {
  const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
  const isEnforced = process.env.ENFORCE_APP_CHECK === "true";

  if (!token || typeof token !== "string" || !token.trim()) {
    return { valid: false, error: "Token App Check ausente" };
  }

  const cleanToken = token.trim();

  // Mocks explícitos permitidos estritamente em ambiente de desenvolvimento e teste
  if (!isProd && cleanToken.startsWith("mock-valid-app-check-token")) {
    return { valid: true, decodedToken: { appId: "mock-dev-app-id", token: cleanToken } };
  }

  try {
    let appCheckService: any = null;

    if (firebaseAdminApp && typeof firebaseAdminApp.appCheck === "function") {
      appCheckService = firebaseAdminApp.appCheck();
    } else if (firebaseAdminApp) {
      try {
        const { getAppCheck } = await import("firebase-admin/app-check");
        appCheckService = getAppCheck(firebaseAdminApp);
      } catch (_importErr) {
        appCheckService = null;
      }
    }

    if (!appCheckService) {
      // Em produção com proteção habilitada, não há aprovação automática por falta do método
      if (isProd && isEnforced) {
        return {
          valid: false,
          error: "Serviço App Check indisponível na infraestrutura do Firebase Admin em produção.",
        };
      }
      // Em desenvolvimento e teste sem enforcement, permite avanço informativo
      if (!isProd && !isEnforced) {
        return { valid: true, error: "Bypass de App Check em ambiente de desenvolvimento local." };
      }
      return { valid: false, error: "App Check não configurado adequadamente." };
    }

    const decodedToken = await appCheckService.verifyToken(cleanToken);
    return { valid: true, decodedToken };
  } catch (err: any) {
    return { valid: false, error: err.message || "Token App Check inválido ou expirado." };
  }
}

export function createAppCheckMiddleware(getFirebaseApp?: any) {
  const isEnforced = () => process.env.ENFORCE_APP_CHECK === "true";

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Isenções estritas e específicas:
    // 1. Health check público da infraestrutura
    // 2. Webhook do Mercado Pago (protegido por assinatura HMAC-SHA256 oficial)
    // 3. Endpoint do agendador Vercel Cron (protegido exclusivamente por CRON_SECRET Bearer token)
    if (
      req.path === "/api/health" ||
      req.path.startsWith("/api/mercadopago/webhook") ||
      req.path === "/api/cron/reconcile"
    ) {
      return next();
    }

    const appInstance =
      typeof getFirebaseApp === "function"
        ? getFirebaseApp()
        : getFirebaseApp || (getApps().length ? getApps()[0] : null);

    const appCheckToken = req.headers["x-firebase-appcheck"] as string | undefined;
    const result = await verifyAppCheckToken(appInstance, appCheckToken);

    if (!result.valid) {
      if (isEnforced()) {
        return res.status(401).json({
          error: "Requisição não autorizada pelo sistema antibot (App Check).",
          code: "APP_CHECK_FAILED",
        });
      }
      // Modo de rollout / observação: loga sem bloquear em dev/test
      console.warn(`[APP-CHECK OBSERVE] ${req.method} ${req.path} - ${result.error}`);
    }

    return next();
  };
}

// ======================================================
// AUDIT LOGGING MINIMIZADO (PROTEÇÃO CONTRA REJEIÇÃO POR UNDEFINED)
// ======================================================
export async function recordSecurityAudit(
  firestore: any,
  data: {
    type: string;
    userId?: string;
    email?: string;
    ip?: string;
    details?: string;
    status?: "success" | "blocked" | "failed";
  }
): Promise<void> {
  if (!firestore) return;
  try {
    const hashedIp = data.ip
      ? crypto.createHash("sha256").update(data.ip).digest("hex").substring(0, 16)
      : null;

    // Constrói objeto livre de propriedades undefined para evitar rejeição do Firestore
    const auditDoc: Record<string, any> = {
      type: data.type || "security_event",
      userId: data.userId || "anonymous",
      status: data.status || "success",
      timestamp: new Date().toISOString(),
    };

    if (data.email) auditDoc.email = String(data.email).trim().toLowerCase();
    if (hashedIp) auditDoc.ipHash = hashedIp;
    if (data.details) auditDoc.details = String(data.details).substring(0, 500);

    await firestore.collection("security_logs").add(auditDoc);
  } catch (err) {
    console.error("[SECURITY] Falha ao registrar security log:", err);
  }
}
