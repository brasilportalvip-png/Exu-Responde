import type { GoogleGenAI } from "@google/genai";

// As variáveis da Vercel têm prioridade sobre estes padrões.
export const GEMINI_MODELS = [
  process.env.GEMINI_PRIMARY_MODEL?.trim() || "gemini-3.8-flash",
  process.env.GEMINI_SECONDARY_MODEL?.trim() || "gemini-3.6-flash",
  process.env.GEMINI_LITE_MODEL?.trim() || "gemini-3.5-flash-lite",
].filter((model, index, models) => Boolean(model) && models.indexOf(model) === index);

export interface GeminiTelemetryResult {
  text: string;
  modelUsed: string;
  attemptsCount: number;
  fallbackCount: number;
  fallbackReasons: string[];
  latencyMs: number;
}

// Orçamento apenas da IA; o limite da função deve também comportar o banco.
export const GEMINI_GLOBAL_TIMEOUT_MS = 22_000;
export const GEMINI_REQUEST_TIMEOUT_MS = 7_500;
export const MAX_ATTEMPTS_PER_MODEL = 2;
const MIN_ATTEMPT_MS = 1_000;
const SAFETY_MARGIN_MS = 500;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

export function getGeminiErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as any;
  for (const value of [e.status, e.response?.status, e.code, e.error?.code]) {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 100 && number <= 599) return number;
  }
  return null;
}

export function isRetryableGeminiError(error: unknown): boolean {
  const status = getGeminiErrorStatus(error);
  if (status !== null) return [408, 429, 500, 502, 503, 504].includes(status);
  const code = (error as any)?.code;
  if (["GEMINI_EMPTY_RESPONSE", "GEMINI_REQUEST_TIMEOUT"].includes(code)) return true;
  const message = messageOf(error).toLowerCase();
  if (/api key not valid|unauthenticated|permission denied|not found/.test(message)) return false;
  return /timeout|timed out|network|fetch failed|socket|connection|rate limit|resource[_ ]exhausted|temporarily unavailable|service unavailable/.test(message);
}

function failure(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export async function executeGeminiWithFallback(
  ai: GoogleGenAI,
  params: { contents: any; systemInstruction: string }
): Promise<GeminiTelemetryResult> {
  const startTime = Date.now();
  const deadline = startTime + GEMINI_GLOBAL_TIMEOUT_MS - SAFETY_MARGIN_MS;
  const errors: string[] = [];
  const fallbackReasons: string[] = [];
  const retryModels = new Set<string>();
  let attemptsCount = 0;
  let fallbackCount = 0;
  let previousModel: string | undefined;
  let budgetExhausted = false;

  // Uma tentativa em cada modelo antes de repetir qualquer modelo.
  for (let round = 1; round <= MAX_ATTEMPTS_PER_MODEL; round++) {
    const models = round === 1 ? GEMINI_MODELS : [...retryModels];
    for (let index = 0; index < models.length; index++) {
      const model = models[index];
      const remaining = deadline - Date.now();
      const remainingModels = models.length - index;
      // Divide o tempo restante para não deixar o último modelo sem oportunidade.
      const requestTimeout = Math.min(GEMINI_REQUEST_TIMEOUT_MS, Math.floor(remaining / remainingModels));
      if (requestTimeout < MIN_ATTEMPT_MS) {
        budgetExhausted = true;
        break;
      }
      if (previousModel !== undefined && previousModel !== model) fallbackCount++;
      previousModel = model;
      attemptsCount++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      console.info(`[GEMINI_ATTEMPT] model=${model} round=${round} timeoutMs=${requestTimeout}`);
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(failure("Tempo limite da tentativa Gemini excedido.", "GEMINI_REQUEST_TIMEOUT"));
            controller.abort();
          }, requestTimeout);
        });
        const response = await Promise.race([
          ai.models.generateContent({
            model,
            contents: params.contents,
            config: {
              systemInstruction: params.systemInstruction,
              abortSignal: controller.signal,
            },
          }),
          timeout,
        ]);
        // Não repetir bloqueios de segurança em outros modelos.
        const finishReason = String(response.candidates?.[0]?.finishReason || "");
        if (response.promptFeedback?.blockReason ||
            ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION", "IMAGE_SAFETY"].includes(finishReason)) {
          throw failure("Não foi possível gerar uma resposta para esta solicitação.", "GEMINI_CONTENT_BLOCKED");
        }
        if (finishReason === "MAX_TOKENS") {
          throw failure("A resposta foi interrompida antes de ser concluída.", "GEMINI_INCOMPLETE_RESPONSE");
        }
        const text = typeof response.text === "string" ? response.text.trim() : "";
        if (!text) throw failure("O modelo retornou resposta vazia.", "GEMINI_EMPTY_RESPONSE");
        return { text, modelUsed: model, attemptsCount, fallbackCount, fallbackReasons, latencyMs: Date.now() - startTime };
      } catch (error: unknown) {
        const status = getGeminiErrorStatus(error);
        const code = (error as any)?.code;
        // Registra diagnóstico no servidor, sem incluir o texto da consulta.
        const reason = `${model}: ${timedOut ? "timeout" : status ?? code ?? "erro de comunicação"}`;
        errors.push(reason);
        fallbackReasons.push(reason);
        console.warn(`[GEMINI_FAILED] ${reason} round=${round}`);
        if (code === "GEMINI_CONTENT_BLOCKED" || status === 401 || status === 403 || status === 400) {
          // Repetir credenciais ou payload inválidos não resolve a falha.
          throw Object.assign(failure("Não foi possível concluir a consulta de IA.", code === "GEMINI_CONTENT_BLOCKED" ? code : "GEMINI_CONFIGURATION_ERROR"), {
            details: errors, fallbackReasons, attemptsCount, latencyMs: Date.now() - startTime,
          });
        }
        if (timedOut || isRetryableGeminiError(error)) retryModels.add(model);
        else retryModels.delete(model);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    }
    if (budgetExhausted) break;
    if (round < MAX_ATTEMPTS_PER_MODEL && retryModels.size > 0) {
      const delay = 300 + Math.floor(Math.random() * 200);
      if (deadline - Date.now() < delay + MIN_ATTEMPT_MS) {
        budgetExhausted = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  // O chamador fará o estorno ou registrará a recuperação; não inventamos uma leitura.
  throw Object.assign(failure("Não foi possível obter uma resposta completa da IA.", "ALL_GEMINI_MODELS_FAILED"), {
    details: errors, fallbackReasons, attemptsCount, fallbackCount,
    latencyMs: Date.now() - startTime, budgetExhausted,
  });
}
