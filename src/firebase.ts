import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken,
  type AppCheck,
} from "firebase/app-check";
import {
  getAuth,
  onAuthStateChanged as fbOnAuthStateChanged,
  signOut as fbSignOut,
  signInWithEmailAndPassword as fbSignInWithEmailAndPassword,
  createUserWithEmailAndPassword as fbCreateUserWithEmailAndPassword,
  sendEmailVerification as fbSendEmailVerification,
  sendPasswordResetEmail as fbSendPasswordResetEmail,
  type Auth,
  type User,
} from "firebase/auth";

const env = (import.meta as any).env || {};
const envString = (name: string): string => typeof env[name] === "string" ? env[name].trim() : "";
const firebaseConfig = {
  apiKey: envString("VITE_FIREBASE_API_KEY"),
  authDomain: envString("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: envString("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: envString("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: envString("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: envString("VITE_FIREBASE_APP_ID"),
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
let app: FirebaseApp | null = null;
let realAuth: Auth | null = null;
let appCheck: AppCheck | null = null;

// Remove apenas a antiga sessão simulada. Não altera a sessão real do Firebase.
if (typeof window !== "undefined") {
  try { window.localStorage.removeItem("exu_dev_user_session"); } catch { /* Armazenamento pode estar bloqueado. */ }
}

if (isFirebaseConfigured) {
  try {
    app = getApps().some(existing => existing.name === "[DEFAULT]") ? getApp() : initializeApp(firebaseConfig);
    realAuth = getAuth(app);
    realAuth.languageCode = "pt-BR";
  } catch {
    console.error("[Firebase] Não foi possível inicializar a autenticação. Confira a configuração do projeto.");
  }
}

// Uma falha no App Check não elimina a instância de Auth já inicializada.
if (app && typeof window !== "undefined") {
  const siteKey = envString("VITE_RECAPTCHA_SITE_KEY");
  if (siteKey && firebaseConfig.appId) {
    try {
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      console.warn("[AppCheck] Não foi possível inicializar a proteção. Confira o cadastro do aplicativo e do reCAPTCHA.");
    }
  }
}

let pendingToken: Promise<string | null> | null = null;
let retryTokenAfter = 0;

export async function getClientAppCheckToken(): Promise<string | null> {
  if (!appCheck) return null;
  if (pendingToken) return pendingToken;
  if (Date.now() < retryTokenAfter) return null;
  const service = appCheck;
  pendingToken = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        getToken(service, false),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("App Check timeout")), 8_000);
        }),
      ]);
      if (typeof result?.token !== "string" || !result.token.trim()) throw new Error("Token ausente");
      retryTokenAfter = 0;
      return result.token;
    } catch {
      retryTokenAfter = Date.now() + 30_000;
      console.warn("[AppCheck] Token indisponível. A autorização da requisição será decidida pelo servidor.");
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  try { return await pendingToken; }
  finally { pendingToken = null; }
}

// Mantém compatibilidade com componentes que leem auth.currentUser.
// Quando o Firebase está indisponível, não existe usuário autenticado nem token simulado.
export const auth: Auth = realAuth || ({
  currentUser: null,
  languageCode: "pt-BR",
} as unknown as Auth);

function requireRealAuth(authInstance: Auth): Auth {
  if (!realAuth || authInstance !== realAuth) {
    throw Object.assign(new Error(
      "Serviço de autenticação indisponível. Confira a configuração do Firebase e tente novamente."
    ), { code: "auth/configuration-unavailable" });
  }
  return realAuth;
}

export function onAuthStateChanged(authInstance: Auth, callback: (user: User | null) => void): () => void {
  if (realAuth) return fbOnAuthStateChanged(requireRealAuth(authInstance), callback);
  const timer = setTimeout(() => callback(null), 0);
  return () => clearTimeout(timer);
}

export async function signOut(authInstance: Auth): Promise<void> {
  if (realAuth) await fbSignOut(requireRealAuth(authInstance));
}

export async function createUserWithEmailAndPassword(
  authInstance: Auth, email: string, password: string
): Promise<{ user: User }> {
  return fbCreateUserWithEmailAndPassword(requireRealAuth(authInstance), email.trim(), password);
}

export async function signInWithEmailAndPassword(
  authInstance: Auth, email: string, password: string
): Promise<{ user: User }> {
  return fbSignInWithEmailAndPassword(requireRealAuth(authInstance), email.trim(), password);
}

export async function sendEmailVerification(user: User): Promise<void> {
  requireRealAuth(auth);
  if (!user || user !== realAuth?.currentUser) {
    throw Object.assign(new Error("Entre novamente para solicitar a verificação do e-mail."), { code: "auth/user-mismatch" });
  }
  // Envia e-mail pelo SDK. A confirmação depende do link recebido pelo usuário.
  await fbSendEmailVerification(user);
}

export async function sendPasswordResetEmail(authInstance: Auth, email: string): Promise<void> {
  await fbSendPasswordResetEmail(requireRealAuth(authInstance), email.trim());
}

export default app;
