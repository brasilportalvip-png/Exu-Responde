import { GoogleGenAI } from "@google/genai";

// ======================================================
// CONFIGURAÇÃO OFICIAL DOS MODELOS GEMINI (ANTIQUEDA)
// Modelos oficiais do SDK @google/genai com fallback progressivo
// ======================================================

export const GEMINI_MODELS = [
  process.env.GEMINI_PRIMARY_MODEL?.trim() || "gemini-2.5-flash",
  process.env.GEMINI_SECONDARY_MODEL?.trim() || "gemini-1.5-flash",
  process.env.GEMINI_LITE_MODEL?.trim() || "gemini-2.0-flash",
].filter((model, index, arr): model is string => Boolean(model) && arr.indexOf(model) === index);

export interface GeminiTelemetryResult {
  text: string;
  modelUsed: string;
  attemptsCount: number;
  fallbackCount: number;
  fallbackReasons: string[];
  latencyMs: number;
}

// Orçamento total equilibrado (22s) para não exceder limites de serverless e reservar tempo para persistência/estorno
export const GEMINI_GLOBAL_TIMEOUT_MS = 22_000;
export const GEMINI_REQUEST_TIMEOUT_MS = 7_500;
export const MAX_ATTEMPTS_PER_MODEL = 2; // Até 2 tentativas por modelo apenas se o erro for transitório/recuperável

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getGeminiErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: number; code?: number; response?: { status?: number } };
  return e.status ?? e.code ?? e.response?.status ?? null;
}

export function isRetryableGeminiError(error: unknown): boolean {
  const status = getGeminiErrorStatus(error);
  // Erros definitivos (400 bad request, 401 unauthenticated, 403 forbidden, 404 not found) NUNCA devem ser retentados no mesmo modelo
  if (status && [400, 401, 403, 404].includes(status)) {
    return false;
  }

  if (status && [408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (
    message.includes("api key not valid") ||
    message.includes("unauthenticated") ||
    message.includes("permission denied") ||
    message.includes("not found")
  ) {
    return false;
  }

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("rate limit") ||
    message.includes("resource exhausted") ||
    message.includes("temporarily unavailable") ||
    message.includes("service unavailable") ||
    message.includes("503") ||
    message.includes("429")
  );
}

export async function executeGeminiWithFallback(
  ai: GoogleGenAI,
  params: {
    contents: any;
    systemInstruction: string;
  }
): Promise<GeminiTelemetryResult> {
  const errors: string[] = [];
  const fallbackReasons: string[] = [];
  const startTime = Date.now();
  let fallbackCount = 0;
  let totalAttempts = 0;

  for (let modelIndex = 0; modelIndex < GEMINI_MODELS.length; modelIndex++) {
    const model = GEMINI_MODELS[modelIndex];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      totalAttempts++;
      const elapsed = Date.now() - startTime;
      const remainingBudget = GEMINI_GLOBAL_TIMEOUT_MS - elapsed;

      // Reserva de segurança de ao menos 2 segundos
      if (remainingBudget < 2000) {
        throw new Error(
          `Orçamento de tempo (${Math.round(GEMINI_GLOBAL_TIMEOUT_MS / 1000)}s) atingido para a chamada de IA.`
        );
      }

      const requestTimeout = Math.min(GEMINI_REQUEST_TIMEOUT_MS, remainingBudget);
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`Timeout de ${Math.round(requestTimeout / 1000)}s no modelo ${model}`));
        }, requestTimeout);
      });

      try {
        const generatePromise = ai.models.generateContent({
          model,
          contents: params.contents,
          config: {
            systemInstruction: params.systemInstruction,
            abortSignal: controller.signal,
          },
        });

        const response = await Promise.race([generatePromise, timeoutPromise]);

        if (timeoutHandle) clearTimeout(timeoutHandle);

        const text = typeof response?.text === "string" ? response.text.trim() : "";
        if (!text) {
          throw new Error(`Modelo ${model} retornou resposta vazia.`);
        }

        const latencyMs = Date.now() - startTime;

        return {
          text,
          modelUsed: model,
          attemptsCount: totalAttempts,
          fallbackCount,
          fallbackReasons,
          latencyMs,
        };
      } catch (err: unknown) {
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const errMsg = err instanceof Error ? err.message : String(err);
        const retryable = isRetryableGeminiError(err);
        errors.push(`${model} (tentativa ${attempt}): ${errMsg}`);

        // Se o erro NÃO for transitório (erro de chave, permissão, payload inválido), pula imediatamente para fallback
        if (!retryable) {
          fallbackReasons.push(`${model}: Erro definitivo [${errMsg}]`);
          break;
        }

        // Se esgotou as tentativas no modelo atual, avança para o próximo modelo na esteira
        if (attempt >= MAX_ATTEMPTS_PER_MODEL) {
          fallbackReasons.push(`${model}: ${MAX_ATTEMPTS_PER_MODEL} tentativas esgotadas [${errMsg}]`);
          break;
        }

        // Backoff rápido com jitter
        const jitter = Math.floor(Math.random() * 200);
        const delay = Math.min(1500, 400 * Math.pow(2, attempt - 1) + jitter);
        await sleep(delay);
      }
    }

    if (modelIndex < GEMINI_MODELS.length - 1) {
      fallbackCount++;
      await sleep(250);
    }
  }

  const exhaustionError: any = new Error(
    "Todos os modelos da esteira de sabedoria ancestral falharam ou esgotaram tentativas."
  );
  exhaustionError.code = "ALL_GEMINI_MODELS_FAILED";
  exhaustionError.details = errors;
  exhaustionError.fallbackReasons = fallbackReasons;
  throw exhaustionError;
}
