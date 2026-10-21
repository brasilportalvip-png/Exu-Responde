import { auth, getClientAppCheckToken } from "./firebase";

export async function parseApiResponse<T extends Record<string, unknown>>(
  response: Response
): Promise<T> {
  const responseText = await response.text();

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    return {
      error:
        response.status >= 500
          ? "O servidor está temporariamente indisponível. Tente novamente em alguns instantes."
          : "O servidor retornou uma resposta inválida. Atualize a página e tente novamente."
    } as unknown as T;
  }
}

export function getUserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "idem_" + Math.random().toString(36).substring(2, 15) + "_" + Date.now();
}

export async function getApiHeaders(options?: {
  idempotencyKey?: string;
  token?: string;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Timezone": getUserTimeZone(),
  };

  // Auth Bearer token
  let token = options?.token;
  if (!token && auth.currentUser) {
    try {
      token = await auth.currentUser.getIdToken();
    } catch {
      // Ignore
    }
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // App Check token
  try {
    const appCheckToken = await getClientAppCheckToken();
    if (appCheckToken) {
      headers["X-Firebase-AppCheck"] = appCheckToken;
    }
  } catch {
    // Ignore
  }

  // Idempotency key
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  return headers;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit & { idempotencyKey?: string; token?: string }
): Promise<Response> {
  const defaultHeaders = await getApiHeaders({
    idempotencyKey: init?.idempotencyKey,
    token: init?.token,
  });

  const headers = {
    ...defaultHeaders,
    ...((init?.headers as Record<string, string>) || {}),
  };

  return fetch(input, {
    ...init,
    headers,
  });
}
