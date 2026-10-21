import type express from "express";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { getApps } from "firebase-admin/app";

function normalizedIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

// Só confia nos cabeçalhos encaminhados quando executado na infraestrutura Vercel.
export function getClientIp(req: express.Request): string {
  if (process.env.VERCEL === "1") {
    for (const name of ["x-vercel-forwarded-for", "x-forwarded-for"]) {
      const header = req.headers[name];
      // Não aceita listas arbitrárias, portas, arrays ou valores que não sejam IP.
      const ip = normalizedIp(header);
      if (ip) return ip;
    }
  }
  // Fora da Vercel, usa o par TCP. Um cliente não escolhe o próprio IP por header.
  return normalizedIp(req.socket?.remoteAddress) || "unknown";
}

export async function verifyAppCheckToken(
  firebaseAdminApp: any,
  token?: string
): Promise<{ valid: boolean; decodedToken?: any; error?: string }> {
  if (typeof token !== "string" || !token.trim()) {
    return { valid: false, error: "Token App Check ausente." };
  }
  const cleanToken = token.trim();
  if (cleanToken.length > 16_384 || cleanToken.startsWith("mock-valid-app-check-token")) {
    return { valid: false, error: "Token App Check inválido." };
  }
  if (!firebaseAdminApp) {
    return { valid: false, error: "Serviço App Check indisponível." };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verification = async () => {
      const service = typeof firebaseAdminApp.appCheck === "function"
        ? firebaseAdminApp.appCheck()
        : (await import("firebase-admin/app-check")).getAppCheck(firebaseAdminApp);
      if (!service || typeof service.verifyToken !== "function") {
        throw new Error("Serviço indisponível");
      }
      // A validação criptográfica, projeto e expiração são conferidos pelo Admin SDK.
      const decoded = await service.verifyToken(cleanToken);
      if (!decoded || typeof decoded.appId !== "string" || !decoded.appId) {
        throw new Error("Token sem appId");
      }
      return decoded;
    };
    const decodedToken = await Promise.race([
      verification(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Tempo limite App Check")), 8_000);
      }),
    ]);
    return { valid: true, decodedToken };
  } catch {
    // Não envia tokens, credenciais nem mensagens internas do SDK ao cliente/log.
    return { valid: false, error: "Não foi possível validar o token App Check." };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAppCheckMiddleware(getFirebaseApp?: any) {
  let nextObservationLogAt = 0;
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const path = req.path;
    // O navegador precisa carregar o site antes de obter seu token App Check.
    if (path !== "/api" && !path.startsWith("/api/")) return next();

    const route = path.endsWith("/") ? path.slice(0, -1) : path;
    const method = req.method.toUpperCase();
    const isHealth = route === "/api/health" && ["GET", "HEAD"].includes(method);
    const isWebhook = route === "/api/mercadopago/webhook" && method === "POST";
    const isCron = route === "/api/cron/reconcile" && ["GET", "POST"].includes(method);
    // Webhook e cron mantêm suas próprias verificações de assinatura e segredo.
    if (isHealth || isWebhook || isCron) return next();

    const enforced = process.env.ENFORCE_APP_CHECK?.trim().toLowerCase() === "true";
    let result: { valid: boolean; decodedToken?: any; error?: string };
    try {
      const appInstance = typeof getFirebaseApp === "function"
        ? await getFirebaseApp()
        : getFirebaseApp || getApps()[0] || null;
      const header = req.headers["x-firebase-appcheck"];
      result = await verifyAppCheckToken(appInstance, typeof header === "string" ? header : undefined);
    } catch {
      result = { valid: false, error: "Inicialização do App Check indisponível." };
    }
    if (result.valid) return next();
    if (enforced) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(401).json({
        error: "Requisição não autorizada pelo sistema antibot (App Check).",
        code: "APP_CHECK_FAILED",
      });
    }
    // Preserva o rollout existente: sem ENFORCE_APP_CHECK=true, apenas observa.
    // Observação não significa token validado, mesmo em produção.
    if (Date.now() >= nextObservationLogAt) {
      nextObservationLogAt = Date.now() + 30_000;
      console.warn("[APP-CHECK OBSERVE] Validação não concluída; bloqueio desativado pela configuração.");
    }
    return next();
  };
}

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
    const ip = normalizedIp(data.ip);
    const auditDoc: Record<string, any> = {
      type: String(data.type || "security_event").slice(0, 100),
      userId: String(data.userId || "anonymous").slice(0, 200),
      status: ["success", "blocked", "failed"].includes(data.status || "") ? data.status : "success",
      timestamp: new Date().toISOString(),
    };
    if (data.email) auditDoc.email = String(data.email).trim().toLowerCase().slice(0, 254);
    // Hash de IP continua sendo dado pseudonimizado, não anonimização garantida.
    if (ip) auditDoc.ipHash = crypto.createHash("sha256").update(ip).digest("hex").substring(0, 16);
    if (data.details) auditDoc.details = String(data.details).substring(0, 500);
    await firestore.collection("security_logs").add(auditDoc);
  } catch {
    console.error("[SECURITY] Não foi possível gravar o registro de auditoria.");
  }
}
