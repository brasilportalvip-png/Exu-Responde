// ======================================================
// CLASSIFICADOR DE INTENÇÃO EXAUSTIVO — AMOR NUNCA É DEFAULT
// ======================================================

export type IntentCategory =
  | "amor_relacionamento"
  | "negocios_sociedade"
  | "trabalho_carreira"
  | "financeiro"
  | "familia"
  | "amizade"
  | "saude"
  | "espiritualidade"
  | "protecao"
  | "decisao"
  | "terceira_pessoa"
  | "geral";

export interface IntentClassification {
  theme: IntentCategory;
  isLove: boolean;
  isBusiness: boolean;
  isJob: boolean;
  isFinance: boolean;
  isFamily: boolean;
  isFriendship: boolean;
  isHealth: boolean;
  isSpiritual: boolean;
  isProtection: boolean;
  isDecision: boolean;
  isThirdPerson: boolean;
  confidence: "high" | "medium" | "low";
}

export function classifyQuestionIntent(text: string): IntentClassification {
  const norm = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  // 1. Negócios, Sociedades e Parcerias Comerciais (prioridade máxima sobre nomes de pessoas)
  const isBusiness = /\b(sociedade|socio|socia|socios|empresa|abrir empresa|negocio|negocios|parceria comercial|sociedade comercial|loja|comercio|ponto comercial|franquia|sociedade com|abrir firma|contrato social)\b/i.test(norm);

  // 2. Trabalho, Emprego, Concursos e Carreira
  const isJob = /\b(emprego|trabalho|trabalhar|trabalharemos|trabalhando|vaga|arrumar emprego|conseguir emprego|entrevista|selecao|promocao|demissao|demitido|concurso|concurso publico|carreira|salario|curriculo|firma|chefe|patrao|contratado|admissao|trabalhando juntos|trabalharemos juntos|trabalharemos bem juntos|trabalhar com)\b/i.test(norm);

  // 3. Financeiro, Dívidas, Investimentos e Dinheiro
  const isFinance = /\b(dinheiro|divida|dividas|empréstimo|emprestimo|investimento|investir|capital|lucro|faturamento|falencia|renda|banco|pagamento|receber dinheiro|heranca|venda de imovel|comprar casa|financiamento)\b/i.test(norm);

  // 4. Família (pais, filhos, irmãos, parentes de sangue)
  const isFamily = /\b(filho|filha|mae|pai|irmao|irma|sobrinho|sobrinha|neto|neta|parente|familia|primo|prima|tio|tia|sogro|sogra|cunhado|cunhada)\b/i.test(norm);

  // 5. Saúde e acolhimento (NUNCA diagnóstico)
  const isHealth = /\b(saude|cura|hospital|medico|cirurgia|doenca|remedio|tratamento|exame|ansiedade|depressao|dor|enfermidade)\b/i.test(norm);

  // 6. Amizade
  const isFriendship = /\b(amigo|amiga|amigos|amigas|amizade|companheiro de estrada|colega|como esta minha amiga|como esta meu amigo)\b/i.test(norm);

  // 7. Proteção, demandas e quebra de feitiço
  const isProtection = /\b(protecao|proteger|inimigo|inveja|olho gordo|feitiço|feitico|macumba|trabalho feito|quebranto|demanda|afastar inimigo|livramento|blindagem)\b/i.test(norm);

  // 8. Espiritualidade, orixás, entidades, mediunidade, ebó
  const isSpiritual = /\b(espiritual|espiritualidade|orixa|orixas|entidade|guia|terreiro|mediunidade|ebo|bori|ifa|odu|incorporacao|batismo|velas|oferenda|axe|laroye)\b/i.test(norm);

  // 9. Tomada de decisão, encruzilhada de escolhas
  const isDecision = /\b(devo ir|devo ficar|qual caminho|o que escolher|duvida cruel|decisao|qual estrada|devo aceitar|fazer ou nao fazer)\b/i.test(norm);

  // 10. Amor e Relacionamento (SOMENTE romance / afeto explícito)
  const isLoveExplicit =
    /\b(amor|paixao|namoro|namorado|namorada|noivo|noiva|casamento|marido|esposa|ficante|crush|amante|traicao|trair|traiu|voltar com|reconciliacao amorosa|saudade dele|saudade dela|ciumes?|desejo sexual|tesao|sentimento amoroso|gosta de mim|me ama|pensa em mim romanticamente|com quem vou casar|alma gemea|vai voltar para mim|separacao amorosa|combina no amor|combinamos no amor|combinam no amor)\b/i.test(norm) ||
    (/\b(ele|ela)\b/i.test(norm) && /\b(me ama|gosta de mim|vai voltar|tem outra|tem outro|me quer|me procura romanticamente|me deseja)\b/i.test(norm));

  // 11. Terceira pessoa geral (perguntas sobre o estado de outra pessoa sem conotação romântica)
  const isThirdPerson = /\b(esta bem|como esta o|como esta a|vai conseguir|esta sofrendo|precisa de ajuda)\b/i.test(norm);

  // HIERARQUIA RIGOROSA: Amor só ganha se NÃO for Negócios, NÃO for Emprego, NÃO for Família e NÃO for Amizade
  let theme: IntentCategory = "geral";
  let isLove = false;

  if (isBusiness) {
    theme = "negocios_sociedade";
  } else if (isJob) {
    theme = "trabalho_carreira";
  } else if (isFinance) {
    theme = "financeiro";
  } else if (isFamily) {
    theme = "familia";
  } else if (isHealth) {
    theme = "saude";
  } else if (isFriendship && !isLoveExplicit) {
    theme = "amizade";
  } else if (isLoveExplicit) {
    theme = "amor_relacionamento";
    isLove = true;
  } else if (isProtection) {
    theme = "protecao";
  } else if (isSpiritual) {
    theme = "espiritualidade";
  } else if (isDecision) {
    theme = "decisao";
  } else if (isThirdPerson) {
    theme = "terceira_pessoa";
  } else {
    theme = "geral";
  }

  return {
    theme,
    isLove,
    isBusiness,
    isJob,
    isFinance,
    isFamily,
    isFriendship,
    isHealth,
    isSpiritual,
    isProtection,
    isDecision,
    isThirdPerson,
    confidence: "high",
  };
}
