import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  calculateSpiritualProfile,
  formatSpiritualProfileForPrompt
} = require("../dist/api.test.cjs");

test("Spiritual Profile: calculateSpiritualProfile gera mapa completo com signos, elementos, planeta e números", () => {
  const profile = calculateSpiritualProfile(
    "Clarice Lispector dos Santos",
    "1990-05-15",
    "10:45",
    "Recife - PE"
  );

  assert.ok(profile, "Perfil deve existir");
  assert.equal(profile.signoSolar, "Touro");
  assert.equal(profile.elementoSigno, "Terra");
  assert.equal(profile.planetaRegente, "Vênus");

  assert.ok(profile.oduPrincipal && profile.oduPrincipal.length > 0, "Odù principal deve existir");
  assert.ok(profile.oduNumero, "Número do Odù deve existir");
  assert.ok(profile.orixaAfinidade, "Orixá de afinidade deve existir");
  assert.ok(profile.exuAfinidade, "Exu de afinidade deve existir");
  assert.ok(profile.arquetipoDominante, "Arquétipo deve existir");
  assert.ok(profile.assinaturaEnergetica, "Assinatura energética deve existir");

  assert.equal(typeof profile.destinyNumber, "number");
  assert.equal(typeof profile.soulNumber, "number");
  assert.equal(typeof profile.expressionNumber, "number");
  assert.equal(typeof profile.personalYear, "number");

  assert.ok(profile.mapaVibracional, "Mapa vibracional deve existir");
  assert.ok(profile.mapaVibracional.Fogo > 0);
  assert.ok(profile.mapaVibracional.Terra > 0);
  assert.ok(profile.mapaVibracional.Ar > 0);
  assert.ok(profile.mapaVibracional.Agua > 0);
});

test("Spiritual Profile Prompt: perfil calculado chega ao prompt Gemini sem nenhum campo 'Não calculado'", () => {
  const user = {
    name: "Clarice",
    birthName: "Clarice Lispector dos Santos",
    birthDate: "1990-05-15",
    birthTime: "10:45",
    birthPlace: "Recife - PE"
  };

  const spiritualProps = calculateSpiritualProfile(
    user.birthName,
    user.birthDate,
    user.birthTime,
    user.birthPlace
  );

  const fullUser = {
    ...user,
    ...spiritualProps
  };

  const promptBlock = formatSpiritualProfileForPrompt(fullUser);

  // Validações rigorosas de contrato do prompt
  assert.ok(promptBlock.includes("- Signo solar: Touro"), "Prompt deve conter o signo correto");
  assert.ok(promptBlock.includes("- Elemento astrológico: Terra"), "Prompt deve conter o elemento astrológico");
  assert.ok(promptBlock.includes("- Planeta regente: Vênus"), "Prompt deve conter o planeta regente");
  assert.ok(promptBlock.includes(`- Odù de afinidade: ${spiritualProps.oduPrincipal}`), "Prompt deve conter o Odù calculado");
  assert.ok(promptBlock.includes(`- Orixá de afinidade: ${spiritualProps.orixaAfinidade}`), "Prompt deve conter o Orixá");
  assert.ok(promptBlock.includes(`- Exu de afinidade: ${spiritualProps.exuAfinidade}`), "Prompt deve conter o Exu");
  assert.ok(promptBlock.includes(`- Arquétipo dominante: ${spiritualProps.arquetipoDominante}`), "Prompt deve conter o Arquétipo");
  assert.ok(promptBlock.includes(`- Número de destino: ${spiritualProps.destinyNumber}`), "Prompt deve conter número de destino");
  assert.ok(promptBlock.includes(`- Número da alma: ${spiritualProps.soulNumber}`), "Prompt deve conter número da alma");
  assert.ok(promptBlock.includes(`- Número de expressão: ${spiritualProps.expressionNumber}`), "Prompt deve conter número de expressão");
  assert.ok(promptBlock.includes(`- Ano pessoal: ${spiritualProps.personalYear}`), "Prompt deve conter ano pessoal");

  // Garante que não sobrou nenhum fallback "Não calculado" ou "Não informado" no mapa completo
  assert.ok(!promptBlock.includes("Não calculado"), "Não deve haver nenhum 'Não calculado' com perfil preenchido");
  assert.ok(!promptBlock.includes("Não calculada"), "Não deve haver nenhum 'Não calculada'");
  assert.ok(!promptBlock.includes("Não informado"), "Não deve haver nenhum 'Não informado'");
});
