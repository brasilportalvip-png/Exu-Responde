/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type SpiritualLevel =
  | "Buscador"
  | "Aprendiz"
  | "Peregrino"
  | "Iniciado"
  | "Guardião"
  | "Conhecedor"
  | "Mestre dos Caminhos";

export interface UserProfile {
  id: string;
  email: string;
  password?: string;
  name: string;
  birthName?: string;
  birthDate?: string;
  birthTime?: string;
  birthPlace?: string;
  level: SpiritualLevel;
  xp: number;
  credits: number;
  role: "admin" | "user";
  avatarSeed: string; // Used to display consistent avatar styles
  createdAt: string;
  
  // Custom generated spiritual parameters
  oduPrincipal?: string;
  orixaAfinidade?: string;
  exuAfinidade?: string;
  arquetipoDominante?: string;
  assinaturaEnergetica?: string;
  mapaVibracional?: { Fogo: number; Terra: number; Ar: number; Agua: number };
  
  // Custom numerology parameters
  destinyNumber?: number;
  soulNumber?: number;
  expressionNumber?: number;
  personalYear?: number;
}

export interface SpiritualMilestone {
  id: string;
  title: string;
  description: string;
  unlockedAt: string;
  xpAwarded: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  sender: "user" | "exu";
  text: string;
  timestamp: string;
  isFavorite?: boolean;
  xpAwarded?: number;
  creditCharged?: number;
}

export interface KnowledgeItem {
  id: string;
  title: string;
  category: "odu" | "itan" | "orixa" | "entidade" | "tarot" | "astrologia" | "filosofia";
  content: string;
  tags: string[];
  createdAt: string;
}

export interface TarotCard {
  id: number;
  name: string;
  arcana: "major" | "minor";
  suit?: "paus" | "copas" | "espadas" | "ouro";
  description: {
    general: string;
    love: string;
    work: string;
    prosperity: string;
    spirituality: string;
  };
  symbol: string; // Symbol character or icon code
}

export interface NumerologyChartDetails {
  destinyNumber: number; // Destino
  soulNumber: number; // Alma
  expressionNumber: number; // Expressão
  personalityNumber: number; // Personalidade
  karmicLessons: number[]; // Lições Kármicas
  personalYear: number; // Ano Pessoal
  analysis: string;
}

export interface AstrologiaDetails {
  sunSign: string;
  element: "Fogo" | "Terra" | "Ar" | "Água";
  rulingPlanet: string;
  dominantHouse: number;
  compatibility: string;
  analysis: string;
}

export interface CreditPlan {
  id: string;
  name: string;
  price: number;
  credits: number;
  bonus: number;
  popular?: boolean;
  color: string;
}

export interface CreditOrder {
  id: string;
  planId: string;
  userId: string;
  amount: number;
  credits: number;
  status: "pending" | "completed";
  paymentMethod: "pix" | "mercado_pago" | "stripe";
  createdAt: string;
}
