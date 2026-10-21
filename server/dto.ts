// ======================================================
// PUBLIC USER DTO & DATA SANITIZATION
// Previne vazamento de IP, deviceId, fraudReasons e dados internos
// ======================================================

export interface PublicUserDTO {
  id: string;
  email: string;
  name: string;
  birthName?: string;
  birthDate?: string;
  birthTime?: string;
  birthPlace?: string;
  level: string;
  xp: number;
  credits: number;
  role: "admin" | "user";
  avatarSeed: string;
  createdAt: string;
  emailVerified: boolean;

  // Parâmetros espirituais calculados legítimos
  oduPrincipal?: string;
  oduNumero?: string;
  oduTipo?: string;
  oduElemento?: string;
  oduLicao?: string;

  signoSolar?: string;
  elementoSigno?: string;
  planetaRegente?: string;

  elementoDominante?: string;
  elementoNumerologico?: string;

  orixaAfinidade?: string;
  exuAfinidade?: string;
  arquetipoDominante?: string;
  assinaturaEnergetica?: string;
  mapaVibracional?: { Fogo: number; Terra: number; Ar: number; Agua: number };

  destinyNumber?: number;
  soulNumber?: number;
  expressionNumber?: number;
  personalYear?: number;
}

export function toPublicUserDTO(docId: string, rawData: Record<string, any>): PublicUserDTO {
  return {
    id: docId,
    email: String(rawData.email || "").trim(),
    name: String(rawData.name || "").trim(),
    birthName: rawData.birthName ? String(rawData.birthName).trim() : undefined,
    birthDate: rawData.birthDate ? String(rawData.birthDate).trim() : undefined,
    birthTime: rawData.birthTime !== undefined ? String(rawData.birthTime).trim() : undefined,
    birthPlace: rawData.birthPlace ? String(rawData.birthPlace).trim() : undefined,
    level: rawData.level || "Buscador",
    xp: Number(rawData.xp || 0),
    credits: Number(rawData.credits || 0),
    role: rawData.role === "admin" ? "admin" : "user",
    avatarSeed: rawData.avatarSeed || "eleg_seed_1",
    createdAt: rawData.createdAt || new Date().toISOString(),
    emailVerified: Boolean(rawData.emailVerified),

    oduPrincipal: rawData.oduPrincipal,
    oduNumero: rawData.oduNumero,
    oduTipo: rawData.oduTipo,
    oduElemento: rawData.oduElemento,
    oduLicao: rawData.oduLicao,

    signoSolar: rawData.signoSolar,
    elementoSigno: rawData.elementoSigno,
    planetaRegente: rawData.planetaRegente,

    elementoDominante: rawData.elementoDominante,
    elementoNumerologico: rawData.elementoNumerologico,

    orixaAfinidade: rawData.orixaAfinidade,
    exuAfinidade: rawData.exuAfinidade,
    arquetipoDominante: rawData.arquetipoDominante,
    assinaturaEnergetica: rawData.assinaturaEnergetica,
    mapaVibracional: rawData.mapaVibracional,

    destinyNumber: rawData.destinyNumber !== undefined ? Number(rawData.destinyNumber) : undefined,
    soulNumber: rawData.soulNumber !== undefined ? Number(rawData.soulNumber) : undefined,
    expressionNumber: rawData.expressionNumber !== undefined ? Number(rawData.expressionNumber) : undefined,
    personalYear: rawData.personalYear !== undefined ? Number(rawData.personalYear) : undefined,
  };
}
