import crypto from "node:crypto";

// ======================================================
// 1. TAROT DE MARSELHA — CSPRNG COM METODOLOGIA RIGOROSA
// 3 Cartas: Passado -> Presente -> Futuro/Tendência
// ======================================================

export interface TarotCardDef {
  id: number;
  nome: string;
  elemento: string;
  traducao: string;
  palavrasChave: string[];
}

export const TAROT_DECK: TarotCardDef[] = [
  { id: 1, nome: "O Louco", elemento: "Ar", traducao: "O Início, a Liberdade e o Desapego", palavrasChave: ["começo", "salto de fé", "liberdade", "risco", "desapego"] },
  { id: 2, nome: "O Mago", elemento: "Ar", traducao: "A Habilidade, o Início e a Comunicação", palavrasChave: ["habilidade", "potencial", "ação", "vontade", "comunicação"] },
  { id: 3, nome: "A Sacerdotisa", elemento: "Água", traducao: "A Intuição, o Segredo e a Espera", palavrasChave: ["intuição", "mistério", "silêncio", "sabedoria interior", "paciência"] },
  { id: 4, nome: "A Imperatriz", elemento: "Terra", traducao: "A Fertilidade, a Abundância e a Criação", palavrasChave: ["crescimento", "abundância", "nutrição", "expressão", "beleza"] },
  { id: 5, nome: "O Imperador", elemento: "Fogo", traducao: "A Estrutura, a Ordem e a Autoridade", palavrasChave: ["autoridade", "firmeza", "disciplina", "controle", "liderança"] },
  { id: 6, nome: "O Papa (O Hierofante)", elemento: "Terra", traducao: "A Tradição, o Ensino e a Fé", palavrasChave: ["tradição", "conselho", "espiritualidade", "princípios", "conformidade"] },
  { id: 7, nome: "Os Enamorados", elemento: "Ar", traducao: "A Escolha, a Dúvida e a Aliança", palavrasChave: ["escolha", "encruzilhada", "atração", "parceria", "alinhamento de valores"] },
  { id: 8, nome: "O Carro", elemento: "Água", traducao: "A Direção, a Vitória e o Domínio", palavrasChave: ["vitória", "determinação", "foco", "superação de obstáculos", "avanço rápido"] },
  { id: 9, nome: "A Justiça", elemento: "Ar", traducao: "A Verdade, o Equilíbrio e a Consequência", palavrasChave: ["justiça", "causa e efeito", "clareza", "lei", "responsabilidade"] },
  { id: 10, nome: "O Eremita", elemento: "Terra", traducao: "O Recolhimento, a Busca e a Prudência", palavrasChave: ["busca interior", "prudência", "reflexão", "guia", "paciência"] },
  { id: 11, nome: "A Roda da Fortuna", elemento: "Fogo", traducao: "O Ciclo, a Mudança e a Oportunidade", palavrasChave: ["virada", "ciclos da vida", "destino", "movimento cósmico", "oportunidade"] },
  { id: 12, nome: "A Força", elemento: "Fogo", traducao: "A Coragem, o Domínio Próprio e a Paixão", palavrasChave: ["coragem", "paciência", "autodomínio", "compaixão", "energia vital"] },
  { id: 13, nome: "O Enforcado", elemento: "Água", traducao: "A Pausa, a Nova Perspectiva e a Renúncia", palavrasChave: ["pausa necessária", "mudança de ângulo", "desapego", "sacrifício consciente", "transição"] },
  { id: 14, nome: "A Morte (A Transformação)", elemento: "Água", traducao: "O Fim de Ciclo, a Queda e o Renascimento", palavrasChave: ["renascimento", "corte inevitável", "fim de ciclo", "limpeza profunda", "regeneração"] },
  { id: 15, nome: "A Temperança", elemento: "Fogo", traducao: "O Equilíbrio, a Harmonia e a Paciência", palavrasChave: ["harmonia", "moderação", "cura", "integração", "calma"] },
  { id: 16, nome: "O Diabo", elemento: "Terra", traducao: "A Ambição, o Desejo, o Apego e a Sombra", palavrasChave: ["desejo intenso", "apego", "sombra", "magnetismo", "prisão emocional"] },
  { id: 17, nome: "A Torre", elemento: "Fogo", traducao: "A Ruptura, a Verdade Repentina e a Libertação", palavrasChave: ["ruptura súbita", "desmoronamento de ilusões", "despertar", "choque de realidade", "libertação"] },
  { id: 18, nome: "A Estrela", elemento: "Ar", traducao: "A Esperança, a Fé e a Inspiração", palavrasChave: ["esperança", "renovação", "cura espiritual", "orientação", "inspiração"] },
  { id: 19, nome: "A Lua", elemento: "Água", traducao: "A Ilusão, os Medos Ocultos e a Intuição", palavrasChave: ["ilusão", "medos inconscientes", "sonhos", "névoa", "profundidade emocional"] },
  { id: 20, nome: "O Sol", elemento: "Fogo", traducao: "A Clareza, a Alegria, a Vitória e a Vitalidade", palavrasChave: ["clareza total", "sucesso", "vitalidade", "abertura de caminhos", "celebração"] },
  { id: 21, nome: "O Julgamento", elemento: "Fogo", traducao: "O Chamado, o Acerto de Contas e o Despertar", palavrasChave: ["chamado", "despertar", "acerto de contas", "renovação", "decisão final"] },
  { id: 22, nome: "O Mundo", elemento: "Terra", traducao: "A Realização Plena, o Fechamento e a Vitória Total", palavrasChave: ["completude", "realização", "sucesso pleno", "triunfo", "ciclo concluído"] },
];

export interface DrawnCard {
  card: TarotCardDef;
  position: "Passado" | "Presente" | "Futuro / Tendência" | "Orientação Geral";
}

export function drawTarotCardsReal(slotsCount: number): DrawnCard[] {
  const count = slotsCount === 3 ? 3 : 1;
  const positions: Array<"Passado" | "Presente" | "Futuro / Tendência"> = [
    "Passado",
    "Presente",
    "Futuro / Tendência",
  ];

  // Algoritmo Fisher-Yates CSPRNG para sorteio justo e sem repetição
  const pool = [...TAROT_DECK];
  const drawn: DrawnCard[] = [];

  for (let i = 0; i < count; i++) {
    const selectedIndex = crypto.randomInt(0, pool.length);
    const card = pool.splice(selectedIndex, 1)[0];
    drawn.push({
      card,
      position: count === 1 ? "Orientação Geral" : positions[i],
    });
  }

  return drawn;
}

// ======================================================
// 2. ORÁCULO DOS 16 BÚZIOS (IFÁ) — LANÇAMENTO CSPRNG REAL
// ======================================================

export interface OduBuziosDef {
  numero: number;
  nome: string;
  orixa: string;
  elemento: string;
  tema: string;
}

export const ODUS_BUZIOS: Record<number, OduBuziosDef> = {
  0: { numero: 0, nome: "Òpìrà", orixa: "Ancestrais / Egun", elemento: "Terra", tema: "Silêncio sagrado, recolhimento absoluto, respeito ao invisível e cautela extrema." },
  1: { numero: 1, nome: "Òkànràn", orixa: "Exu", elemento: "Fogo", tema: "Começo difícil, teimosia, palavra afiada, aviso de perigo e necessidade de ouvir antes de agir." },
  2: { numero: 2, nome: "Èjì Òkò", orixa: "Ibeji / Ogum", elemento: "Terra", tema: "União, parceria, dúvida entre dois caminhos, equilíbrio e construção em conjunto." },
  3: { numero: 3, nome: "Ètà Ògúndá", orixa: "Ogum", elemento: "Fogo", tema: "Guerra, trabalho duro, conquista pelo próprio esforço, corte de amarras e superação." },
  4: { numero: 4, nome: "Ìrosùn", orixa: "Oxóssi / Yemanjá", elemento: "Terra", tema: "Visão, alerta contra armadilhas e traições, intuição aguçada e respeito aos ancestrais." },
  5: { numero: 5, nome: "Òsé", orixa: "Oxum", elemento: "Água", tema: "Amor, beleza, fertilidade, inteligência sutil, cuidado com vaidade e mágoas do coração." },
  6: { numero: 6, nome: "Òbàrà", orixa: "Oxóssi / Xangô", elemento: "Ar", tema: "Prosperidade súbita, riqueza, comércio favorável, poder da palavra e cuidado com fofocas." },
  7: { numero: 7, nome: "Òdí", orixa: "Obaluaê / Oxalufan", elemento: "Terra", tema: "Firmeza, fechamento de corpo, segredo bem guardado, paciência e perseverança." },
  8: { numero: 8, nome: "Èjì Onílè", orixa: "Oxaguiã", elemento: "Ar", tema: "Vitória, ambição, liderança, progresso rápido, paz após a tempestade e caminhos abertos." },
  9: { numero: 9, nome: "Òsá", orixa: "Oyá (Iansã)", elemento: "Fogo", tema: "Ventos de mudança, transformação incontrolável, coragem feminina e quebra de estagnação." },
  10: { numero: 10, nome: "Òfún", orixa: "Oxalá", elemento: "Ar", tema: "Paz, sabedoria profunda, honra, respeito aos preceitos, mistério e bênção ancestral." },
  11: { numero: 11, nome: "Òwónrín", orixa: "Oyá / Exu", elemento: "Fogo", tema: "Virada imprevista, agilidade mental, atenção a golpes e renovação dos planos." },
  12: { numero: 12, nome: "Èjìlá Ṣeborá", orixa: "Xangô", elemento: "Fogo", tema: "Justiça implacável, cobrança cármica, retidão moral e vitória para quem estiver correto." },
  13: { numero: 13, nome: "Ìká", orixa: "Nanã / Oxumaré", elemento: "Água", tema: "Cuidado com venenos sutis e inveja oculta, persistência, regeneração e proteção mística." },
  14: { numero: 14, nome: "Òtúrúpòn", orixa: "Obaluaê", elemento: "Terra", tema: "Cura, superação de dores antigas, paciência perante a prova e renovação da saúde." },
  15: { numero: 15, nome: "Òtúrá", orixa: "Ifá / Oxalá", elemento: "Ar", tema: "Sabedoria espiritual superior, visão clara dos destinos, iluminação e caminhos limpos." },
  16: { numero: 16, nome: "Ìretè", orixa: "Nanã / Orunmila", elemento: "Terra", tema: "Longevidade, raiz profunda, firmeza contra todas as tempestades e bênção da terra." },
};

export interface BuziosCastResult {
  abertosCount: number;
  fechadosCount: number;
  shells: boolean[]; // true = aberto, false = fechado
  odu: OduBuziosDef;
}

export function castBuziosReal(): BuziosCastResult {
  const shells: boolean[] = [];
  let abertosCount = 0;

  // 16 conchas lançadas individualmente via CSPRNG
  for (let i = 0; i < 16; i++) {
    const isOpen = crypto.randomInt(0, 2) === 1;
    shells.push(isOpen);
    if (isOpen) abertosCount++;
  }

  const fechadosCount = 16 - abertosCount;
  const odu = ODUS_BUZIOS[abertosCount] || ODUS_BUZIOS[0];

  return {
    abertosCount,
    fechadosCount,
    shells,
    odu,
  };
}
