import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyQuestionIntent } = require("../dist/api.test.cjs");

test("Intent Classifier: Negócios e Sociedade nunca caem em amor", () => {
  const t1 = classifyQuestionIntent("Estou abrindo uma sociedade com Flavio Roberto Ortiz Costa 02/02/1983, teremos sucesso?");
  assert.equal(t1.theme, "negocios_sociedade");
  assert.equal(t1.isLove, false);
  assert.equal(t1.isBusiness, true);

  const t2 = classifyQuestionIntent("Somos compatíveis para abrir sociedade?");
  assert.equal(t2.theme, "negocios_sociedade");
  assert.equal(t2.isLove, false);

  const t3 = classifyQuestionIntent("Meu irmão e eu vamos abrir uma empresa?");
  assert.equal(t3.theme, "negocios_sociedade");
  assert.equal(t3.isLove, false);
});

test("Intent Classifier: Trabalho e Emprego nunca caem em amor", () => {
  const t1 = classifyQuestionIntent("João Rogério Braga 13/08/1967 vai arrumar emprego?");
  assert.equal(t1.theme, "trabalho_carreira");
  assert.equal(t1.isLove, false);
  assert.equal(t1.isJob, true);

  const t2 = classifyQuestionIntent("Eu e João trabalharemos bem juntos?");
  assert.equal(t2.theme, "trabalho_carreira");
  assert.equal(t2.isLove, false);
  assert.equal(t2.isJob, true);

  const t3 = classifyQuestionIntent("Eu e João teremos sucesso trabalhando juntos?");
  assert.equal(t3.theme, "trabalho_carreira");
  assert.equal(t3.isLove, false);
});

test("Intent Classifier: Família e Amizade nunca caem em amor", () => {
  const t1 = classifyQuestionIntent("Como está minha amiga Maria?");
  assert.notEqual(t1.theme, "amor_relacionamento");
  assert.equal(t1.isLove, false);
  assert.equal(t1.isFriendship, true);

  const t2 = classifyQuestionIntent("Minha amiga Maria está bem?");
  assert.notEqual(t2.theme, "amor_relacionamento");
  assert.equal(t2.isLove, false);
  assert.equal(t2.isFriendship, true);

  const t3 = classifyQuestionIntent("Minha irmã e eu vamos nos entender?");
  assert.equal(t3.theme, "familia");
  assert.equal(t3.isLove, false);
  assert.equal(t3.isFamily, true);
});

test("Intent Classifier: Amor somente quando contexto é explicitamente amoroso", () => {
  const t1 = classifyQuestionIntent("Eu e Maria combinamos no amor?");
  assert.equal(t1.theme, "amor_relacionamento");
  assert.equal(t1.isLove, true);

  const t2 = classifyQuestionIntent("Ele ainda me ama e vai voltar para mim?");
  assert.equal(t2.theme, "amor_relacionamento");
  assert.equal(t2.isLove, true);
});

test("Intent Classifier: Saúde separada de Família", () => {
  const t1 = classifyQuestionIntent("Preciso de forças para a cirurgia e recuperação da minha saúde no hospital.");
  assert.equal(t1.theme, "saude");
  assert.equal(t1.isHealth, true);
  assert.equal(t1.isLove, false);
});

test("Intent Classifier: Financeiro e Proteção", () => {
  const t1 = classifyQuestionIntent("Como pagar minhas dívidas e organizar meu dinheiro?");
  assert.equal(t1.theme, "financeiro");
  assert.equal(t1.isFinance, true);

  const t2 = classifyQuestionIntent("Sinto muita inveja e mau olhado no meu caminho, preciso de proteção.");
  assert.equal(t2.theme, "protecao");
  assert.equal(t2.isProtection, true);
});
