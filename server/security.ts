import type express from "express";
import crypto from "node:crypto";
import { getApps } from "firebase-admin/app";

// ======================================================
// OBTENÇÃO SEGURA DE IP REAL (SEM CONFIAR CEGAMENTE EM SPOOFING)
// ======================================================
export function getClientIp(req: express.Request): string {
  // Vercel / Cloudflare headers são adicionados pelo edge proxy confiável
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
    // Primeiro IP do header é o cliente real na cadeia
    const ips = xForwardedFor.split(",").map((ip) => ip.trim());
    if (ips[0]) return ips[0];
  }

  return req.socket?.remoteAddress || req.ip || "127.0.0.1";
}

// ======================================================
// FIREBASE APP CHECK / ANTIBOT VERIFICATION
// ======================================================
export async function verifyAppCheckToken(
  firebaseAdminApp: any,
  token?: string
): Promise<{ valid: boolean; decodedToken?: any; error?: string }> {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token App Check ausente" };
  }

  if (!firebaseAdminApp || typeof firebaseAdminApp.appCheck !== "function") {
    // Ambiente sem App Check habilitado (ex: dev local)
    return { valid: true };
  }

  try {
    const appCheckService = firebaseAdminApp.appCheck();
    const decodedToken = await appCheckService.verifyToken(token);
    return { valid: true, decodedToken };
  } catch (err: any) {
    return { valid: false, error: err.message || "Token App Check inválido" };
  }
}

export function createAppCheckMiddleware(getFirebaseApp?: any) {
  const isEnforced = () => process.env.ENFORCE_APP_CHECK === "true";

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Isenção explícita para health check e webhook oficial do Mercado Pago
    if (
      req.path === "/api/health" ||
      req.path.startsWith("/api/mercadopago/webhook")
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
      // Modo de rollout / observação: loga sem bloquear
      console.warn(`[APP-CHECK OBSERVE] ${req.method} ${req.path} - ${result.error}`);
    }

    return next();
  };
}

// ======================================================
// AUDIT LOGGING MINIMIZADO
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
      : undefined;

    await firestore.collection("security_logs").add({
      type: data.type,
      userId: data.userId || "anonymous",
      email: data.email,
      ipHash: hashedIp,
      details: data.details,
      status: data.status || "success",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[SECURITY] Falha ao registrar security log:", err);
  }
}
