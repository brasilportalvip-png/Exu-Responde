import { z } from "zod";

// ======================================================
// SCHEMAS DE VALIDAÇÃO RIGOROSA SERVER-SIDE (Zod)
// ======================================================

export function isValidIanaTimeZone(tz?: string): boolean {
  if (!tz || typeof tz !== "string" || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseBirthDateStrict(birthDate: string): {
  year: number;
  month: number;
  day: number;
  isValid: boolean;
  isAdult: boolean;
} {
  if (!birthDate || typeof birthDate !== "string") {
    return { year: 1900, month: 1, day: 1, isValid: false, isAdult: false };
  }

  const clean = birthDate.trim();
  let year = 0;
  let month = 0;
  let day = 0;

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const parts = clean.split("-").map(Number);
    year = parts[0];
    month = parts[1];
    day = parts[2];
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const parts = clean.split("/").map(Number);
    day = parts[0];
    month = parts[1];
    year = parts[2];
  } else {
    return { year: 1900, month: 1, day: 1, isValid: false, isAdult: false };
  }

  const today = new Date();
  const currentYear = today.getFullYear();

  if (year < 1900 || year > currentYear || month < 1 || month > 12 || day < 1) {
    return { year, month, day, isValid: false, isAdult: false };
  }

  // Verifica dias do mês com tratamento real de anos bissextos
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) {
    return { year, month, day, isValid: false, isAdult: false };
  }

  // Não pode ser data futura
  const birthDateObj = new Date(year, month - 1, day);
  if (birthDateObj > today) {
    return { year, month, day, isValid: false, isAdult: false };
  }

  // Regra 18+
  let age = currentYear - year;
  const m = (today.getMonth() + 1) - month;
  if (m < 0 || (m === 0 && today.getDate() < day)) {
    age--;
  }

  const isAdult = age >= 18;

  return { year, month, day, isValid: true, isAdult };
}

export const registerBodySchema = z.object({
  birthName: z.string().trim().min(2, "Nome deve ter ao menos 2 caracteres").max(100, "Nome muito longo"),
  birthDate: z.string().trim().refine((val) => {
    const parsed = parseBirthDateStrict(val);
    return parsed.isValid;
  }, { message: "Data de nascimento inválida (use o formato AAAA-MM-DD)." })
  .refine((val) => {
    const parsed = parseBirthDateStrict(val);
    return parsed.isAdult;
  }, { message: "O portal é restrito para maiores de 18 anos conforme os Termos de Uso." }),
  birthTime: z.string().trim().regex(/^(\d{2}:\d{2})?$/, "Horário deve ser no formato HH:mm").optional().default(""),
  birthPlace: z.string().trim().max(100, "Local muito longo").optional().default(""),
  email: z.string().trim().email("E-mail inválido").max(150),
  deviceId: z.string().trim().max(100).optional().default("dev_not_tracked"),
  browser: z.string().trim().max(150).optional().default("unknown"),
  session: z.string().trim().max(150).optional().default("unknown"),
  honeypot: z.string().max(50).optional(),
  termsAccepted: z.literal(true, {
    message: "Você deve aceitar os Termos de Uso para prosseguir."
  }),
  privacyAccepted: z.literal(true, {
    message: "Você deve aceitar a Política de Privacidade para prosseguir."
  }),
  termsVersion: z.string().trim().min(1, "Versão dos termos obrigatória").optional().default("1.0"),
  privacyVersion: z.string().trim().min(1, "Versão da política obrigatória").optional().default("1.0"),
});

export const userUpdateSchema = z.object({
  name: z.string().trim().min(2, "Nome deve ter ao menos 2 caracteres").max(100).optional(),
  birthName: z.string().trim().min(2, "Nome natal deve ter ao menos 2 caracteres").max(100).optional(),
  birthDate: z.string().trim().refine((val) => !val || parseBirthDateStrict(val).isValid, {
    message: "Data de nascimento inválida (use o formato AAAA-MM-DD)."
  }).optional(),
  birthTime: z.string().trim().regex(/^(\d{2}:\d{2})?$/, "Horário deve ser no formato HH:mm").optional().default(""),
  birthPlace: z.string().trim().max(100, "Local muito longo").optional().default(""),
});

export const chatBodySchema = z.object({
  text: z.string().trim().min(1, "Mensagem vazia").max(2000, "Mensagem não pode exceder 2000 caracteres"),
  type: z.enum(["comum", "completa", "outros"]).optional().default("comum"),
  timezone: z.string().trim().max(64).optional()
});

export const tarotBodySchema = z.object({
  slotsCount: z.union([z.literal(1), z.literal(3)]).optional().default(1),
  question: z.string().trim().max(500, "Pergunta não pode exceder 500 caracteres").optional().default(""),
  timezone: z.string().trim().max(64).optional()
});

export const buziosBodySchema = z.object({
  question: z.string().trim().max(500, "Pergunta não pode exceder 500 caracteres").optional().default(""),
  timezone: z.string().trim().max(64).optional()
});

export const numerologiaBodySchema = z.object({
  birthName: z.string().trim().max(100).optional(),
  birthDate: z.string().trim().refine((val) => parseBirthDateStrict(val).isValid, {
    message: "Data de nascimento inválida (use AAAA-MM-DD)."
  }),
  timezone: z.string().trim().max(64).optional()
});

export const astrologiaBodySchema = z.object({
  birthDate: z.string().trim().refine((val) => parseBirthDateStrict(val).isValid, {
    message: "Data de nascimento inválida (use AAAA-MM-DD)."
  }),
  timezone: z.string().trim().max(64).optional()
});

export const adminCreditAdjustSchema = z.object({
  targetUserId: z.string().trim().min(1, "ID do usuário obrigatório"),
  amount: z.number().int("Quantidade deve ser inteira").refine((n) => n !== 0, "Valor não pode ser zero").refine((n) => n >= -1000 && n <= 1000, "Valor fora do limite seguro (-1000 a 1000)"),
  reason: z.string().trim().min(3, "Informe um motivo com pelo menos 3 caracteres").max(250, "Motivo muito longo")
});

export const idempotencyKeySchema = z.string().trim().regex(/^[a-zA-Z0-9_\-]{8,128}$/, "Idempotency-Key deve conter entre 8 e 128 caracteres alfanuméricos, hífens ou underscores.");
