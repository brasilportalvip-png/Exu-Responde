import { GoogleGenAI } from "@google/genai";

// ======================================================
// CONFIGURAÇÃO OFICIAL DOS MODELOS GEMINI (ANTIQUEDA)
// Ordem rigorosa: gemini-3.8-flash -> gemini-flash-latest -> gemini-3.1-flash-lite
// Modelos oficiais disponíveis no SDK @google/genai
// ======================================================

export const GEMINI_MODELS = [
  process.env.GEMINI_PRIMARY_MODEL?.trim() || "gemini-3.8-flash",
  process.env.GEMINI_SECONDARY_MODEL?.trim() || "gemini-flash-latest",
  process.env.GEMINI_LITE_MODEL?.trim() || "gemini-3.1-flash-lite",
].filter((model, index, arr): model is string => Boolean(model) && arr.indexOf(model) === index);

export interface GeminiTelemetryResult {
  text: string;
  modelUsed: string;
  attemptsCount: number;
  fallbackCount: number;
  fallbackReasons: string[];
  latencyMs: number;
}

export const GEMINI_GLOBAL_TIMEOUT_MS = 45_000;
export const GEMINI_REQUEST_TIMEOUT_MS = 18_000;
export const MAX_ATTEMPTS_PER_MODEL = 2; // Até 2 tentativas por modelo apenas se o erro for recuperável

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
  if ([408, 429, 500, 502, 503, 504].includes(status ?? 0)) {
    return true;
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

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

      if (remainingBudget < 2500) {
        throw new Error(
          `Orçamento global de tempo (${Math.round(GEMINI_GLOBAL_TIMEOUT_MS / 1000)}s) esgotado para consulta espiritual.`
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

        // Se o erro NÃO for recuperável (400, 401, 403, modelo inexistente), não adianta retentar o mesmo modelo
        if (!retryable) {
          fallbackReasons.push(`${model}: Erro definitivo [${errMsg}]`);
          break;
        }

        // Se esgotou as tentativas no modelo atual, avança para o próximo modelo na hierarquia
        if (attempt >= MAX_ATTEMPTS_PER_MODEL) {
          fallbackReasons.push(`${model}: ${MAX_ATTEMPTS_PER_MODEL} tentativas esgotadas [${errMsg}]`);
          break;
        }

        // Backoff exponencial com jitter
        const jitter = Math.floor(Math.random() * 300);
        const delay = Math.min(2500, 600 * Math.pow(2, attempt - 1) + jitter);
        await sleep(delay);
      }
    }

    if (modelIndex < GEMINI_MODELS.length - 1) {
      fallbackCount++;
      await sleep(500);
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
