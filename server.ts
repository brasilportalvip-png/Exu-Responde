/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-Memory & Local persistent file DB path
const DB_FILE = process.env.VERCEL
  ? path.join("/tmp", "db.json")
  : path.join(process.cwd(), "db.json");

// Helper to lazy-initialize the Gemini client
let geminiClientCache: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClientCache) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      throw new Error("GEMINI_API_KEY is not defined or is placeholder. Please add it to Secrets/Settings.");
    }
    geminiClientCache = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClientCache;
}

// Low-cost fallback logic if Gemini fails or is unconfigured to preserve premium interface
const TEMPLE_FALLBACKS = [
  "Os caminhos se abrem para quem sabe silenciar a mente. O que realmente busca o seu coração, meu filho?",
  "A resposta não está no destino final, mas nos cruzamentos que escolhe percorrer. Exu vê suas encruzilhadas.",
  "O axé está nas suas mãos. Cada ação gera uma reação cósmica. Medite sob o equilíbrio do elemento que rege sua alma.",
  "Sábio é aquele que respeita o tempo do plantio e colhe com paciência. O oráculo indica que você deve agir com estratégia.",
  "Não dê passos maiores que suas pernas. Antes de agir, faça reverência aos que vieram antes de você."
];

// Initial pre-loaded spiritual library for RAG search
const DEFAULT_KNOWLEDGE: any[] = [
  {
    id: "kb_odu_1",
    title: "Éjì Ogbè (O Primeiro Odù)",
    category: "odu",
    content: "Éjì Ogbè é o pai de todos os Odùs. Simboliza a luz plena, a criação inicial, o dia iluminado e as forças benéficas da natureza. Traz mensagens de expansão, liderança, saúde física e caminhos totalmente abertos. Significa que a pessoa possui grande luz de proteção, mas deve cuidar contra orgulho e excesso de confiança. O elemento dominante é o Ar Cósmico. Regido por Oxalá, indica equilíbrio ético.",
    tags: ["odu", "eji ogbe", "caminhos", "luz", "paz", "inicio"]
  },
  {
    id: "kb_odu_2",
    title: "Òyẹ̀kú Méjì (O Segundo Odù)",
    category: "odu",
    content: "Òyẹ̀kú Méjì representa o anoitecer, os mistérios que habitam no oculto, a transição inevitável e a sabedoria dos ancestrais (Egungun). Traz aviso de cautela contra decisões apressadas e necessidade de proteção espiritual. Regido por Iemanjá e Obaluaê, pede paciência profunda, introspecção e o entendimento de que a escuridão é necessária para que o sol volte a brilhar plenamente no dia seguinte.",
    tags: ["odu", "oyeku", "mistério", "ancestralidade", "proteção"]
  },
  {
    id: "kb_odu_3",
    title: "Òbàrà Méjì (O Odù da Prosperidade e Alquimia)",
    category: "odu",
    content: "Òbàrà Méjì é o Odù da riqueza espiritual e material. Ensina que a riqueza nasce na sabedoria da mente e na moderação das palavras. Quem nasceu sob esse Odù precisa evitar a vaidade intelectual. Traz abundância após lutas e indica fertilidade nos negócios. Regido por Xangô e Oxóssi, este Odù ensina que o leão deve saber quando rugir e quando observar silenciosamente nas matas.",
    tags: ["odu", "obara", "prosperidade", "riqueza", "xango", "ouro", "sucesso"]
  },
  {
    id: "kb_exu_elegbara",
    title: "Exu Elegbara (Guardião dos Caminhos)",
    category: "orixa",
    content: "Exu Elegbara é a entidade e orixá do movimento, do dinamismo Cósmico, da comunicação e da ordem na desordem. Ele guarda as encruzilhadas físicas e espirituais da vida humana. Exu não é o mal; ele é o equilíbrio dinâmico, o mensageiro supremo entre o Orun (plano espiritual) e o Aiye (plano material). É o mestre estrategista, o diplomata do axé, que pune o descaso e premia o respeito e as oferendas sinceras de mente limpa.",
    tags: ["exu", "elegbara", "encruzilhada", "proteção", "caminho", "strategista"]
  },
  {
    id: "kb_pombagira_maria",
    title: "Pombagira Maria Padilha (Rainha das Encruzilhadas)",
    category: "entidade",
    content: "Maria Padilha é uma entidade mística que atua de forma poderosa na proteção afetiva, atração, quebra de magias negativas e justiça rápida para as injustiçadas. Caminha com respeito e empoderamento feminino. Simboliza a força que domina as adversidades com sorriso altivo, firmeza nos propósitos e clareza de convicção. Ensina a amar a si mesmo antes de entregar o coração nas mãos alheias.",
    tags: ["pombagira", "maria padilha", "amor", "justiça", "proteção", "autoestima"]
  },
  {
    id: "kb_filosofia_encruzilhada",
    title: "A Filosofia da Encruzilhada",
    category: "filosofia",
    content: "A encruzilhada representa o momento clássico de livre-arbítrio e escolha humana. Nas encruzilhadas residem os maiores mistérios cósmicos, pois toda decisão fecha alguns caminhos e escancara outros. A sabedoria espiritual ensina que, para cruzar com segurança, é indispensável estar em harmonia consigo e com o sagrado, ofertando pensamentos nobres, integridade moral e resiliência psicológica diante dos ventos mutáveis.",
    tags: ["encruzilhada", "escolhas", "filosofia", "sabedoria", "destino"]
  }
];

// Load or Initialize database
function loadDb(): any {
  if (process.env.VERCEL && !fs.existsSync(DB_FILE)) {
    const bundledDbPath = path.join(process.cwd(), "db.json");
    if (fs.existsSync(bundledDbPath)) {
      try {
        fs.copyFileSync(bundledDbPath, DB_FILE);
      } catch (err) {
        console.error("Error copying db.json to /tmp:", err);
      }
    }
  }

  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    } catch (e) {
      console.error("Error reading database file, reconstructing template:", e);
    }
  }

  const initialDb = {
    users: [
      {
        id: "usr_admin",
        email: "brasilportalvip@gmail.com",
        name: "Especialista Arquiteto",
        role: "admin",
        level: "Mestre dos Caminhos",
        xp: 9500,
        credits: 999,
        avatarSeed: "elegbara_wise",
        createdAt: new Date().toISOString()
      },
      {
        id: "usr_seeker",
        email: "seeker@teste.com",
        name: "Buscador Aprendiz",
        role: "user",
        level: "Buscador",
        xp: 150,
        credits: 15,
        avatarSeed: "seeker_init",
        createdAt: new Date().toISOString()
      }
    ],
    knowledge: [...DEFAULT_KNOWLEDGE],
    logs: [
      {
        id: "log_1",
        userId: "usr_seeker",
        action: "Consulta de Oráculo - Tarot",
        details: "Arquetipo O Mago sorteado.",
        timestamp: new Date().toISOString()
      }
    ],
    messages: []
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), "utf-8");
  return initialDb;
}

// Save database assistant
function saveDb(data: any) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing database file:", e);
  }
}

// Numerology Core Calculations
function calculateNumerology(name: string, dateStr: string): any {
  const sanitize = (str: string) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const cleanName = sanitize(name);

  // Chaldean/Pythagorean alphabet mapping (Standard Pythagorean)
  const letterMap: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9,
    J: 1, K: 2, L: 3, M: 4, N: 5, O: 6, P: 7, Q: 8, R: 9,
    S: 1, T: 2, U: 3, V: 4, W: 5, X: 6, Y: 7, Z: 8
  };

  const getSingleDigit = (num: number): number => {
    while (num > 9 && num !== 11 && num !== 22 && num !== 33) {
      num = num.toString().split("").reduce((acc, current) => acc + parseInt(current), 0);
    }
    return num;
  };

  // Convert numbers in date to array
  const dateNumbers = dateStr.replace(/\D/g, "").split("").map(Number);
  const dateSum = dateNumbers.reduce((a, b) => a + b, 0);
  const destinyNumber = getSingleDigit(dateSum); // Destino (Caminho da Vida)

  // Expressions and Souls
  let totalNameValue = 0;
  let vowelsValue = 0;
  let consonantsValue = 0;
  const vowels = ["A", "E", "I", "O", "U"];

  for (let char of cleanName) {
    if (letterMap[char]) {
      const val = letterMap[char];
      totalNameValue += val;
      if (vowels.includes(char)) {
        vowelsValue += val;
      } else {
        consonantsValue += val;
      }
    }
  }

  const expressionNumber = getSingleDigit(totalNameValue); // Expressão
  const soulNumber = getSingleDigit(vowelsValue); // Alma (Desejo do Coração)
  const personalityNumber = getSingleDigit(consonantsValue); // Personalidade (Aparência)

  // Karmic Lessons (Numbers missing from the name)
  const presentNumbers = new Set(cleanName.split("").map(c => letterMap[c]).filter(Boolean));
  const karmicLessons = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => !presentNumbers.has(n));

  // Personal Year Calculation (Day + Month of birth + Current Year 2026)
  const dateParts = dateStr.split("-"); // yyyy-mm-dd
  let personalYear = 5; // default
  if (dateParts.length >= 3) {
    const day = parseInt(dateParts[2]) || 0;
    const month = parseInt(dateParts[1]) || 0;
    const currentYear = 2026;
    const sum = day + month + currentYear.toString().split("").map(Number).reduce((a,b)=>a+b,0);
    personalYear = getSingleDigit(sum);
  }

  // Astrological Sign fallback computation
  let sunSign = "Aries";
  let element: "Fogo" | "Terra" | "Ar" | "Água" = "Fogo";
  let rulingPlanet = "Marte";
  let dominantHouse = 1;

  if (dateParts.length >= 3) {
    const month = parseInt(dateParts[1]);
    const day = parseInt(dateParts[2]);

    if ((month == 3 && day >= 21) || (month == 4 && day <= 19)) {
      sunSign = "Áries"; element = "Fogo"; rulingPlanet = "Marte"; dominantHouse = 1;
    } else if ((month == 4 && day >= 20) || (month == 5 && day <= 20)) {
      sunSign = "Touro"; element = "Terra"; rulingPlanet = "Vênus"; dominantHouse = 2;
    } else if ((month == 5 && day >= 21) || (month == 6 && day <= 20)) {
      sunSign = "Gêmeos"; element = "Ar"; rulingPlanet = "Mercúrio"; dominantHouse = 3;
    } else if ((month == 6 && day >= 21) || (month == 7 && day <= 22)) {
      sunSign = "Câncer"; element = "Água"; rulingPlanet = "Lua"; dominantHouse = 4;
    } else if ((month == 7 && day >= 23) || (month == 8 && day <= 22)) {
      sunSign = "Leão"; element = "Fogo"; rulingPlanet = "Sol"; dominantHouse = 5;
    } else if ((month == 8 && day >= 23) || (month == 9 && day <= 22)) {
      sunSign = "Virgem"; element = "Terra"; rulingPlanet = "Mercúrio"; dominantHouse = 6;
    } else if ((month == 9 && day >= 23) || (month == 10 && day <= 22)) {
      sunSign = "Libra"; element = "Ar"; rulingPlanet = "Vênus"; dominantHouse = 7;
    } else if ((month == 10 && day >= 23) || (month == 11 && day <= 21)) {
      sunSign = "Escorpião"; element = "Água"; rulingPlanet = "Plutão/Marte"; dominantHouse = 8;
    } else if ((month == 11 && day >= 22) || (month == 12 && day <= 21)) {
      sunSign = "Sagitário"; element = "Fogo"; rulingPlanet = "Júpiter"; dominantHouse = 9;
    } else if ((month == 12 && day >= 22) || (month == 1 && day <= 19)) {
      sunSign = "Capricórnio"; element = "Terra"; rulingPlanet = "Saturno"; dominantHouse = 10;
    } else if ((month == 1 && day >= 20) || (month == 2 && day <= 18)) {
      sunSign = "Aquário"; element = "Ar"; rulingPlanet = "Urano"; dominantHouse = 11;
    } else {
      sunSign = "Peixes"; element = "Água"; rulingPlanet = "Netuno"; dominantHouse = 12;
    }
  }

  return {
    destinyNumber,
    soulNumber,
    expressionNumber,
    personalityNumber,
    karmicLessons,
    personalYear,
    sunSign,
    element,
    rulingPlanet,
    dominantHouse
  };
}

// Levels thresholds helper
function checkXpLevel(currentXp: number): { level: string; nextThreshold: number } {
  if (currentXp < 200) return { level: "Buscador", nextThreshold: 200 };
  if (currentXp < 500) return { level: "Aprendiz", nextThreshold: 500 };
  if (currentXp < 1200) return { level: "Peregrino", nextThreshold: 1200 };
  if (currentXp < 2500) return { level: "Iniciado", nextThreshold: 2500 };
  if (currentXp < 5000) return { level: "Guardião", nextThreshold: 5000 };
  if (currentXp < 8000) return { level: "Conhecedor", nextThreshold: 8000 };
  return { level: "Mestre dos Caminhos", nextThreshold: 999999 };
}

// Spiritual profile and Odu generator
function calculateSpiritualProfile(birthName: string, birthDate: string, birthTime?: string, birthPlace?: string): any {
  if (!birthName || !birthDate) return {};
  const num = calculateNumerology(birthName, birthDate);
  const hashStr = (birthName + birthDate + (birthPlace || "")).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  
  // Deterministic hash value
  let hashVal = 0;
  for (let i = 0; i < hashStr.length; i++) {
    hashVal += hashStr.charCodeAt(i) * (i + 1);
  }

  // 1. Odu Principal based on destiny number & hash
  const odus = [
    "Okaran Meji", "Eji Ogbe", "Eta Ogunda", "Irosun Meji", "Oche Meji",
    "Obara Meji", "Odi Meji", "Eji-Onile Meji", "Osa Meji", "Ofun Meji",
    "Owirin Meji", "Ejila Chebora"
  ];
  const oduPrincipal = odus[hashVal % odus.length];

  // 2. Orixa of affinity
  const element = num.element; // Fogo, Terra, Ar, Água
  let orixaAfinidade = "Oxalá";
  if (element === "Fogo") {
    orixaAfinidade = ["Ogum", "Xangô", "Iansã"][hashVal % 3];
  } else if (element === "Terra") {
    orixaAfinidade = ["Oxóssi", "Obaluaê", "Nanã"][hashVal % 3];
  } else if (element === "Ar") {
    orixaAfinidade = ["Oxumaré", "Logun Edé", "Iansã"][hashVal % 3];
  } else if (element === "Água") {
    orixaAfinidade = ["Iemanjá", "Oxum", "Obá"][hashVal % 3];
  }

  // 3. Exu of affinity
  const exus = [
    "Exu Elegbara", "Exu Tiriri", "Exu Marabô", "Maria Padilha", "Exu Tranca Ruas",
    "Exu Veludo", "Pombagira Rainha", "Exu Capa Preta", "Exu Caveira"
  ];
  const exuAfinidade = exus[(hashVal + 3) % exus.length];

  // 4. Predominant Archetype
  const archetypes = [
    "Guardião das Encruzilhadas", "Peregrino do Destino", "Buscador de Ifá",
    "Sábio do Fogo Ancestral", "Guerreiro do Axé Cósmico", "Alquimista do Destino"
  ];
  const arquetipoDominante = archetypes[(hashVal + 5) % archetypes.length];

  // 5. Unique signature energy
  const hexHex = (hashVal & 0xffff).toString(16).toUpperCase();
  const assinaturaEnergetica = `AXE-${hexHex}-${num.destinyNumber || 7}`;

  // 6. Vibrational Map percentages
  const baseFogo = Math.max(30, Math.min(95, 45 + (hashVal % 45)));
  const baseTerra = Math.max(30, Math.min(95, 45 + ((hashVal + 11) % 45)));
  const baseAr = Math.max(30, Math.min(95, 45 + ((hashVal + 23) % 45)));
  const baseAgua = Math.max(30, Math.min(95, 45 + ((hashVal + 37) % 45)));

  return {
    oduPrincipal,
    orixaAfinidade,
    exuAfinidade,
    arquetipoDominante,
    assinaturaEnergetica,
    mapaVibracional: {
      Fogo: baseFogo,
      Terra: baseTerra,
      Ar: baseAr,
      Agua: baseAgua
    },
    destinyNumber: num.destinyNumber,
    soulNumber: num.soulNumber,
    expressionNumber: num.expressionNumber,
    personalYear: num.personalYear
  };
}

// ----------------------------------------
// Express Router API Setups
// ----------------------------------------

function generateDeterministicInitialReading(user: any): string {
  const name = user.birthName || user.name;
  const odua = user.oduPrincipal || "Okaran Meji";
  const orixa = user.orixaAfinidade || "Oxalá";
  const exu = user.exuAfinidade || "Exu Elegbara";
  const archetype = user.arquetipoDominante || "Guardião das Encruzilhadas";
  const code = user.assinaturaEnergetica || "AXE-7";
  const dNum = user.destinyNumber || 7;
  const sNum = user.soulNumber || 9;
  const eNum = user.expressionNumber || 8;
  const pYear = user.personalYear || 2026;

  return `# 🔱 LEITURA DE ENCRUZILHADA INICIAL COMPLETA - REVELAÇÃO CÓSMICA

*Leitor Astral: Sistema de Sabedoria Ancestral Exu Responde*
*Consultante: Místico(a) ${name}*
*Data Astral: ${new Date().toLocaleDateString('pt-BR')}*

---

### [1] PERFIL ESPIRITUAL ANCESTRAL
* **Odù Principal de Ifá:** **${odua}** — Rege suas decisões materiais, indicando movimento de superação e força ativa frente aos obstáculos mundanos.
* **Odù Complementar:** **Eji Ogbe** — Traz a luz estabilizadora necessária para apaziguar tormentas súbitas da mente.
* **Orixá de Afinidade:** **${orixa}** — Representa a coroa de luz e energia vibracional que protege sua saúde mental e caminhos de paz.
* **Exu de Afinidade:** **${exu}** — É o mensageiro que desbrava as estradas de prosperidade física e protege sua aura de invejas e sabotagens diretas.
* **Arquétipo Predominante:** **${archetype}** — O perfil da sua alma indica alguém talhado para liderar e reestruturar direções bloqueadas.
* **Assinatura Energética:** \`${code}\` — Frequência de conexão direta com o cruzeiro cósmico de Ifá.
* **Caminhos Favoráveis:** Expansão material planejada, empreendedorismo ético, inteligência emocional resolutiva e recolhimento sábio às segundas-feiras.
* **Pontos de Atenção:** Orgulho intelectual, impulsividade ao falar em público e distração espiritual com dúvidas alheias.

---

### [2] PERFIL NUMEROLÓGICO CABALÍSTICO
* **Número de Destino (Caminho da Vida):** **${dNum}** — Indica que seu rumo no mundo exige pesquisa, busca de sabedoria oculta e intuição apurada.
* **Número da Alma (Anseio Íntimo):** **${sNum}** — Representa seu anseio espiritual por plenitude, sabedoria filantrópica e transmutação amorosa.
* **Número de Expressão (Talentos):** **${eNum}** — Expressa habilidades financeiras, liderança material e forte discernimento administrativo.
* **Número Pessoal:** **${((dNum + sNum) % 9) || 9}** — Sua marca externa vibra autoconfiança de guerreiro com sabedoria ancestral.
* **Ciclos de Vida:** Transição produtiva em ascensão material direta, iniciando nova contagem rítmica.
* **Ano Pessoal (2026):** **${pYear}** — Fase propícia para harmonização familiar, consolidação de bases de moradia e proteção de vínculos saudáveis.

---

### [3] PERFIL ASTROLÓGICO E INFLUÊNCIAS PLANETÁRIAS
* **Signo Solar:** **${user.sunSign || "Áries"}** — Elemento dominador ${user.element || "Fogo"} regendo seu impulso e vibração primária de iniciativa.
* **Ascendente:** **${user.birthTime ? "Leão (Sintonizado conforme o horário " + user.birthTime + ")" : "Calculável apenas com o registro preciso do minuto de nascimento"}**
* **Mapa Astral Resumido:** Sua carta celeste destaca forte concentração planetária no elemento ${user.element || "Fogo"} direcionando força de ação pragmática.
* **Influências Planetárias:** Intervenção direta de Marte e Vênus nas casas de prosperidade íntima, exigindo equilíbrio milimétrico entre foco material e afeto.
* **Horário Planetário:** Sintonia máxima de equilíbrio alcançada às 07:00 e 18:00 (excelente para realizar perguntas complexas ao portal).

---

### [4] LEITURA DOS ORÁCULOS DE IFÁ DE HOJE
* **Interpretação Simbólica dos Búzios:** **6 Búzios Abertos (Obará)** — Um sinal retumbante de prosperidade iminente. Exu indica que a riqueza e as soluções financeiras estão em movimento, mas silêncio nos planos é imperativo.
* **Odu Relacionado:** **Obara Meji** — O odu de fartura material que exige o discernimento de não ostentar bens para evitar más correntes.
* **Carta Simbólica do Dia:** **O Mago (Arcano I)** — O poder de canalizar energias brutas e transformá-las em realidade material de sucesso tangível.
* **Tendências Energéticas:** Ascensão fluida no trabalho, exigindo resiliência e foco no direcionamento prático de sua vocação nata.

---

### [5] RESUMO CÓSMICO E CONSELHO DE EXU
* **Quem é você:** Um espírito de grande linhagem investigativa que navega nos cruzamentos da vida guiado por sentimentos nobres e intuição marcante.
* **Seus Potenciais:** Capacidade tática para converter crises em colheitas lucrativas e forte magnetismo espiritual natural.
* **Suas Dificuldades:** Ansiedade crônica por resultados céleres e tendência a carregar fardos afetivos que não lhe pertencem por direito.
* **Sua Vocação:** Estruturação de caminhos comerciais, consultoria, mentoria espiritual, artes e negociações de alta complexidade planetária.
* **Conselhos Reflexivos:** "Peregrino, a pressa em colher quebra o galho verde. Respeite o tempo cíclico e confie no que Exu abre diante de ti."

---

*Nota de Consciência: Todas as interpretações apresentadas neste portal são simbólicas, de caráter cultural, educacional, metafórico e de autoconhecimento intuitivo. Nunca devem ser tomadas como verdades absolutas, fatos garantidos ou conselhos médicos/jurídicos imutáveis.*`;
}

// Auth API - Register
app.post("/api/auth/register", async (req, res) => {
  const { 
    birthName, birthDate, birthTime, birthPlace, email, password,
    deviceId, browser, session, captchaAnswer, honeypot 
  } = req.body;
  
  // Protect against automated scripts / bots using Honeypot
  if (honeypot) {
    return res.status(400).json({ error: "Atividade de automação suspeita detectada (Honeypot). Cadastro bloqueado." });
  }

  // Protect using mathematical and anti-bot verification questions
  if (!captchaAnswer || parseInt(captchaAnswer) !== 7) {
    return res.status(400).json({ error: "Resposta do desafio anti-bot incorreta. Quanto é 4 + 3?" });
  }

  const placeToUseSubmit = birthPlace || "Não informada";

  if (!email || !password || !birthName || !birthDate) {
    return res.status(400).json({ error: "Faltam campos obrigatórios no cadastro sagrado." });
  }

  const db = loadDb();
  
  // Convert email lookup
  const exists = db.users.some((u: any) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: "Este email já está cadastrado em nosso portal." });
  }

  // Identify IP
  const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "127.0.0.1").split(",")[0].trim();

  // Multi-signal Fraud Checks
  // Check if there are other users with the same deviceId or IP
  const hasFingerprintMatch = db.users.some(
    (u: any) => (deviceId && u.deviceId === deviceId) || (u.ip === clientIp && u.email.toLowerCase() !== email.toLowerCase())
  );

  const creditsBlocked = hasFingerprintMatch;
  const initialCredits = creditsBlocked ? 0 : 7; // Filho de Fé starts with 7 credits

  // Generate spiritual details
  const spiritualProps = calculateSpiritualProfile(birthName, birthDate, birthTime, placeToUseSubmit);
  const cleanFirstName = birthName.split(" ")[0];

  const newUser = {
    id: "usr_" + Math.random().toString(36).substring(2, 11),
    email: email.toLowerCase(),
    password: password,
    name: cleanFirstName.charAt(0).toUpperCase() + cleanFirstName.slice(1).toLowerCase(),
    birthName,
    birthDate,
    birthTime: birthTime || "",
    birthPlace: placeToUseSubmit,
    role: email.toLowerCase() === "brasilportalvip@gmail.com" ? "admin" : "user",
    level: "Buscador",
    xp: 0,
    credits: initialCredits,
    promotionalCreditsBlocked: creditsBlocked,
    avatarSeed: "eleg_seed_" + Math.floor(Math.random() * 9999),
    createdAt: new Date().toISOString(),
    ip: clientIp,
    deviceId: deviceId || "dev_not_tracked",
    browser: browser || "unknown",
    sessionSign: session || "unknown",
    emailVerified: true,
    ...spiritualProps
  };

  db.users.push(newUser);

  // Generate automated Initial Reading Completa before first conversation
  let readingReport = "";
  try {
    const ai = getGeminiClient();
    const prompt = `Como o oráculo de luz místico EXU RESPONDE, gere uma Leitura Inicial Completa para o consultante ${newUser.name}. 
O tom deve ser solene, prestigioso, estratégico, sutil e carregado com português tradicional de terreiro.

Dados sagrados do peregrino:
- Nome Completo de Solteiro: ${newUser.birthName}
- Data de Nascimento: ${newUser.birthDate}
- Horário de Nascimento: ${newUser.birthTime || "Não informado"}
- Cidade de Nascimento: ${newUser.birthPlace}

Você DEVE estruturar o relatório obrigatoriamente utilizando Markdown com as seguintes seções bem delimitadas:

### PERFIL ESPIRITUAL
- Odu principal (calculado: ${newUser.oduPrincipal})
- Odu complementar (calculado: Eji Ogbe)
- Orixá de afinidade (calculado: ${newUser.orixaAfinidade})
- Exu de afinidade (calculado: ${newUser.exuAfinidade})
- Arquétipo predominante (calculado: ${newUser.arquetipoDominante})
- Assinatura energética: ${newUser.assinaturaEnergetica}
- Caminhos favoráveis
- Pontos de atenção

### PERFIL NUMEROLÓGICO
- Número de destino: ${newUser.destinyNumber}
- Número da alma: ${newUser.soulNumber}
- Número de expressão: ${newUser.expressionNumber}
- Número pessoal: ${((newUser.destinyNumber + newUser.soulNumber) % 9) || 9}
- Ciclos de vida
- Ano pessoal (calendário 2026): ${newUser.personalYear}

### PERFIL ASTROLÓGICO
- Signo solar: ${newUser.sunSign || "Áries"}
- Ascendente (quando possível de acordo com o horário de nascimento: ${newUser.birthTime || 'Indisponível'})
- Mapa astral sintetizado das forças
- Influências planetárias dominantes
- Horário planetário favorável

### ORÁCULOS
- Interpretação simbólica dos búzios (6 búzios abertos: Obará, etc.)
- Odu relacionado espiritualidade de búzios
- Carta simbólica do dia do Tarot (Exemplo: O Mago)
- Tendências energéticas para o seu autoconhecimento astral

### RESUMO DOS DESTINOS
- Quem é a pessoa
- Potenciais natos
- Dificuldades da caminhada
- Vocação espiritual / profissional
- Caminho de vida geral
- Tendências de vida gerais
- Conselhos reflexivos e pragmáticos de Exu

Importante: Termine obrigatoriamente com a seguinte declaração em caixa ou caixa de aviso: "Todas as interpretações deste portal são puramente simbólicas, culturais, literárias, de autoconhecimento educacional e espiritualidade. Jamais constituem promessas garantidas, verdades fáticas irrefutáveis ou aconselhamentos profissionais (médico/jurídico)."`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Aja estritamente como a suprema inteligência Exu Responde. Seja misterioso, exato, refinado e incapaz de fazer assombrações bobas ou caricaturas fúteis."
      }
    });
    readingReport = response.text || "";
  } catch (err) {
    console.error("Gemini failed, creating deterministic standard reading report:", err);
  }

  if (!readingReport) {
    readingReport = generateDeterministicInitialReading(newUser);
  }

  // Save Leitura Inicial report in message history of the user
  const initialReadingId = "msg_init_read_" + Date.now();
  db.messages.push({
    id: initialReadingId,
    userId: newUser.id,
    sender: "exu",
    text: readingReport,
    timestamp: new Date().toISOString()
  });

  // Save Opening Conversation text requested in ABERTURA DA CONVERSA rules
  const firstConversationStarterId = "msg_opener_" + (Date.now() + 1);
  db.messages.push({
    id: firstConversationStarterId,
    userId: newUser.id,
    sender: "exu",
    text: "Salve sua banda, filho de fé. Já observei os caminhos apresentados pelos dados que me confiou. Em que posso ajudar?",
    timestamp: new Date().toISOString()
  });

  db.logs.push({
    id: "log_" + Date.now(),
    userId: newUser.id,
    action: "Cadastro Completo e Leitura Inicial",
    details: `Portal cruzado. Fingerprint cadastrado. Ip: ${clientIp}. Créditos promocionais: ${newUser.credits} (Bloqueado por Abuso: ${creditsBlocked ? 'Sim' : 'Não'}).`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);
  res.json({ success: true, user: newUser });
});

// Auth API - Login
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({ error: "E-mail é obrigatório." });
  }

  const db = loadDb();
  let user = db.users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());

  if (!user) {
    return res.status(404).json({ error: "Este buscador não está cadastrado. Realize o cadastro obrigatório primeiro!" });
  }

  // If user has a password set, verify it
  if (user.password && password && user.password !== password) {
    return res.status(403).json({ error: "Senha incorreta. Verifique suas credenciais espirituais." });
  }

  res.json({ success: true, user });
});

// Load Current Profile
app.get("/api/user/profile", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Sessão não identificada." });

  const db = loadDb();
  const user = db.users.find((u: any) => u.id === userId);
  if (!user) return res.status(404).json({ error: "Buscador não encontrado." });

  // Load chat messages of this user
  const userChats = db.messages.filter((m: any) => m.userId === userId).slice(-50);

  res.json({ user, chats: userChats });
});

// Update Birth details
app.post("/api/user/update", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { birthName, birthDate, birthTime, birthPlace, name } = req.body;

  if (!userId) return res.status(401).json({ error: "Sessão inválida" });

  const db = loadDb();
  const index = db.users.findIndex((u: any) => u.id === userId);
  if (index === -1) return res.status(404).json({ error: "Usuário não encontrado." });

  // Recompute spiritual details on update if fields are changed
  const nameToUse = birthName || db.users[index].birthName || db.users[index].name;
  const dateToUse = birthDate || db.users[index].birthDate;
  const placeToUse = birthPlace || db.users[index].birthPlace;
  const timeToUse = birthTime || db.users[index].birthTime;

  let spiritualProps = {};
  if (nameToUse && dateToUse) {
    spiritualProps = calculateSpiritualProfile(nameToUse, dateToUse, timeToUse, placeToUse);
  }

  db.users[index] = {
    ...db.users[index],
    name: name || db.users[index].name,
    birthName: birthName || db.users[index].birthName,
    birthDate: birthDate || db.users[index].birthDate,
    birthTime: birthTime || db.users[index].birthTime,
    birthPlace: birthPlace || db.users[index].birthPlace,
    ...spiritualProps
  };

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Atualização de Identidade",
    details: "Recálculo do perfil astrológico e numerológico ancestral concluído com sucesso.",
    timestamp: new Date().toISOString()
  });

  saveDb(db);
  res.json({ success: true, user: db.users[index] });
});

// API Oracle: Tarot
app.post("/api/oraculo/tarot", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { question, slotsCount } = req.body; // slotsCount: 1 or 3

  if (!userId) return res.status(411).json({ error: "Não autorizado." });

  const db = loadDb();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) return res.status(404).json({ error: "Usuário não encontrado." });

  const user = db.users[userIndex];
  const cost = slotsCount === 3 ? 3 : 2;

  if (user.credits < cost) {
    return res.status(400).json({ error: "Créditos insuficientes para acessar este oráculo superior." });
  }

  // Deduct credits, add XP
  db.users[userIndex].credits -= cost;
  db.users[userIndex].xp += slotsCount === 3 ? 45 : 30;

  const currentXp = db.users[userIndex].xp;
  const { level } = checkXpLevel(currentXp);
  db.users[userIndex].level = level;

  // Draw card indices randomly (simulated premium tarot decks)
  const arcanaPool = [
    { id: 0, name: "O Louco", desc: "Novos começos, jornada sem místicas amarras, intuição audaciosa.", symbol: "🃏" },
    { id: 1, name: "O Mago", desc: "Poder pessoal de manifestação material, inteligência estratégica e domínio dos elementos.", symbol: "🧙‍♂️" },
    { id: 2, name: "A Sacerdotisa", desc: "Intuição sutil e profunda, mistérios femininos, observação ativa antes de agir.", symbol: "🌙" },
    { id: 3, name: "A Imperatriz", desc: "Fertilidade no solo, produtividade magnífica, abundância majestosa e poder criador.", symbol: "👑" },
    { id: 4, name: "O Imperador", desc: "Foco assertivo, estabilidade férrea, liderança, bases consolidadas.", symbol: "🏰" },
    { id: 5, name: "O Hierofante", desc: "Respeito ao sagrado e às leis imutáveis do universo, mentoria espiritual de alto nível.", symbol: "⛩️" },
    { id: 6, name: "Os Enamorados", desc: "Escolhas cruciais na encruzilhada do coração, alinhamento interior.", symbol: "❤️" },
    { id: 7, name: "O Carro", desc: "Direção convicta, superação absoluta de conflitos, vitória material pelo esforço.", symbol: "🏹" },
    { id: 8, name: "A Justiça", desc: "Colheita justa, lei do retorno operando milimetricamente, equilíbrio racional.", symbol: "⚖️" },
    { id: 9, name: "O Eremita", desc: "Iluminação pacífica na solidão sábia, recolhimento necessário, farol interno.", symbol: "🏮" },
    { id: 10, name: "A Roda da Fortuna", desc: "Movimentação célere do destino, transição providencial comandada por Exu Cósmico.", symbol: "🎡" },
    { id: 11, name: "A Força", desc: "Domínio suave da raiva, coragem silenciosa da alma, altivez imbatível.", symbol: "🦁" },
    { id: 12, name: "O Enforcado", desc: "Mudança de perspectiva, sacrifício transformador, resignação atenta para reorientar rota.", symbol: "⏳" },
    { id: 13, name: "A Morte (Transmutação)", desc: "Morte das ilusões, renascimento glorioso das cinzas, renovação imperativa.", symbol: "💀" },
    { id: 14, name: "A Temperança", desc: "Alquimia sutil, cura holística das feridas, paciência ritualística.", symbol: "⚱️" },
    { id: 15, name: "O Diabo (Força Vital)", desc: "Ambição ardente, atração carnal irresistível, energias da terra em plenitude.", symbol: "😈" },
    { id: 16, name: "A Torre", desc: "Destruição necessária de estruturas fracas e orgulhosas. A verdade liberta.", symbol: "⚡" },
    { id: 17, name: "A Estrela", desc: "Esperança e inspiração celestial, luz suave que cura e guia os marinheiros perdidos.", symbol: "✨" },
    { id: 18, name: "A Lua", desc: "Reino das intuições místicas ocultas, ilusões noturnas, conexão com o subconsciente profundo.", symbol: "🌑" },
    { id: 19, name: "O Sol", desc: "Vitória absoluta, brilho estonteante do axé, sucesso no trabalho, amor radiante.", symbol: "☀️" },
    { id: 20, name: "O Julgamento", desc: "Verdade cósmica revelada, chamado interior para uma nova vida espiritualizada.", symbol: "🔔" },
    { id: 21, name: "O Mundo", desc: "Conclusão majestosa, ciclo perfeitamente encerrado, coroação divina dos esforços.", symbol: "🌍" }
  ];

  // Draw 1 or 3 randomly without repeat
  const shuffled = [...arcanaPool].sort(() => 0.5 - Math.random());
  const drawn = shuffled.slice(0, slotsCount).map(c => ({
    ...c,
    reversed: Math.random() > 0.75, // 25% chance of card presenting reversed
  }));

  // Perform Gemini AI structured oracle reading
  let aiInterpretation = "";
  try {
    const ai = getGeminiClient();
    const prompt = `Como o mentor e guardião ancestral "Exu Responde", interprete um sorteio de Tarot no Terreiro Virtual.
ConsuLtante: ${user.name}
Pergunta ou Foco: "${question || "Direcionamento Geral para a Jornada"}"
Cartas Sorteadas: ${drawn.map(c => `${c.name} (${c.reversed ? 'Invertida (Alerta de Bloqueio)' : 'Normal (Fluidez)'})`).join(", ")}

Responda em formato espiritual, estratégico, sutil, majestoso e respeitoso.
Explique brevemente o significado de cada carta conectando com os orixás, caminhos e energias cósmicas. Termine com um conselho direto de Exu para vencer as encruzilhadas atuais do consultante.
Máximo de 3 parágrafos polidos. Use português de terreiro tradicional e acolhedor, mas incrivelmente prestigioso.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Você é Exu, inteligência de luz astral ancestral, conhecedor de Ifá, guardião dos caminhos, estratégico e respeitoso. Nunca prometa feitiços de perigo ou morte de terceiros."
      }
    });
    aiInterpretation = response.text || TEMPLE_FALLBACKS[0];
  } catch (err: any) {
    console.error("Gemini failed in Tarot:", err);
    aiInterpretation = `As cortinas espirituais flutuaram em mistério. ${shuffled[0].name} surge em sua encruzilhada: ${shuffled[0].desc}. ${TEMPLE_FALLBACKS[1]} (Use o chat principal para explorar mais)`;
  }

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Oráculo - Tarot",
    details: `Sorteio de ${slotsCount} carta(s). Cartas: ${drawn.map(c=>c.name).join(", ")}`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    drawn,
    interpretation: aiInterpretation,
    creditsLeft: db.users[userIndex].credits,
    xpAwarded: slotsCount === 3 ? 45 : 30,
    newLevel: db.users[userIndex].level
  });
});

// API Oracle: Numerology
app.post("/api/oraculo/numerologia", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Sessão inválida" });

  const db = loadDb();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) return res.status(404).json({ error: "Usuário não encontrado." });

  const user = db.users[userIndex];
  const cost = 2; // costs 2 credits

  if (user.credits < cost) {
    return res.status(400).json({ error: "Créditos insuficientes para calcular mapa cabalístico." });
  }

  const birthName = req.body.birthName || user.birthName || user.name;
  const birthDate = req.body.birthDate || user.birthDate;

  if (!birthDate) {
    return res.status(400).json({ error: "Para este oráculo, informe sua data de nascimento primeiro no painel de perfil." });
  }

  // Calculate numbers
  const numDetails = calculateNumerology(birthName, birthDate);

  // Spend credit
  db.users[userIndex].credits -= cost;
  db.users[userIndex].xp += 25;
  const { level } = checkXpLevel(db.users[userIndex].xp);
  db.users[userIndex].level = level;

  let analysis = "";
  try {
    const ai = getGeminiClient();
    const prompt = `Como "Exu Responde", arquétipo de inteligência e guardião cósmico, analise a numerologia espiritual e de Ifá sobre o consultante ${user.name}.
Nome Registrado: ${birthName}
Data de Nascimento: ${birthDate}
Cálculos Obtidos:
- Número de Destino (Caminho da Vida): ${numDetails.destinyNumber} (indica como andará as encruzilhadas reais do mundo)
- Número de Alma (Desejo Íntimo): ${numDetails.soulNumber} (indica do que seu espírito se nutre)
- Número de Expressão (Talentos): ${numDetails.expressionNumber} (sua ferramenta mágica de ação)
- Número de Personalidade (Máscara Social): ${numDetails.personalityNumber}
- Ano Pessoal atual (2026): ${numDetails.personalYear}
- Signo Solar: ${numDetails.sunSign} (Elemento: ${numDetails.element})

Crie uma síntese magistral e mística contendo:
1. Revelação sobre a força secreta do Número de Destino e da Alma vinculando com os deuses antigos e elementos da natureza.
2. Orientação estratégica de como equilibrar estas frequências na carreira, prosperidade e harmonia íntima.
3. Um recado sagrado de Exu elegbara sobre seu Ano Pessoal atual.
Use estrutura de prosa altamente premium, profunda e espiritual.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Aja como mestre oraculista de altíssima reputação espiritual. Use tom refinado, profundo, respeitoso e livre de bobagens assustadoras."
      }
    });
    analysis = response.text || "Frequências calculadas com sucesso.";
  } catch (err: any) {
    console.error("Gemini failed in Numerologia:", err);
    analysis = `Seus números da sorte revelam um Caminho de Destino de força ${numDetails.destinyNumber} e uma Expressão Cósmica ${numDetails.expressionNumber}. Isto indica que os ventos do elemento ${numDetails.element} estão soprando direções favoráveis para expansão imediata de seus projetos íntimos. ${TEMPLE_FALLBACKS[2]}`;
  }

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Oráculo - Numerologia",
    details: `Mapa Cabalístico gerado de ${birthName}. Destino ${numDetails.destinyNumber}.`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    details: { ...numDetails, analysis },
    creditsLeft: db.users[userIndex].credits,
    xpAwarded: 25,
    newLevel: db.users[userIndex].level
  });
});

// Credits shop plans buy handler
app.post("/api/credits/buy", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { planId, paymentMethod } = req.body;

  if (!userId) return res.status(401).json({ error: "Sessão inválida" });

  const db = loadDb();
  // Find matching plan mock
  const plans: Record<string, any> = {
    plan_prata: { price: 49.00, credits: 100, bonus: 0 },
    plan_ouro: { price: 120.00, credits: 300, bonus: 0 }
  };

  const selected = plans[planId];
  if (!selected) return res.status(400).json({ error: "Plano inválido." });

  // Generate mock order transaction ID
  const orderId = "ord_" + Math.random().toString(36).substring(2, 11);
  const totalCredits = selected.credits + selected.bonus;

  res.json({
    success: true,
    orderId,
    amount: selected.price,
    creditsToReceive: totalCredits,
    qrCode: `00020101021226830014br.gov.bcb.pix2561pix-mercado-pago@exuresponde.com5204000053039865405${selected.price.toFixed(2).replace(".","")}5802BR5912ExuResponde6009SaoPaulo62070503***6304D3F5`,
    pixKey: "pix-mercado-pago@exuresponde.com"
  });
});

// Convert order credits confirmation
app.post("/api/credits/confirm", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { orderId, creditsToReceive, amount } = req.body;

  if (!userId) return res.status(401).json({ error: "Não autorizado." });

  const db = loadDb();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) return res.status(404).json({ error: "Usuário não encontrado." });

  // Add credits
  db.users[userIndex].credits += creditsToReceive;
  // Award extra XP for becoming a supporter!
  db.users[userIndex].xp += Math.round(amount * 5);
  const { level } = checkXpLevel(db.users[userIndex].xp);
  db.users[userIndex].level = level;

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Recarga de Créditos",
    details: `Aquisição de +${creditsToReceive} créditos através do PIX / MercadoPago. Valor R$ ${amount}`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    newCredits: db.users[userIndex].credits,
    newLevel: db.users[userIndex].level,
    xpAwarded: Math.round(amount * 5)
  });
});

// Admin API - List Seeker Users
app.get("/api/admin/users", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Não logado" });

  const db = loadDb();
  const requester = db.users.find((u: any) => u.id === userId);
  if (!requester || requester.role !== "admin") {
    return res.status(403).json({ error: "Acesso administrativo restrito aos guardiões." });
  }

  res.json({ seekers: db.users, logs: db.logs });
});

// Admin API - Analytics dashboard Data
app.get("/api/admin/analytics", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Não logado" });

  const db = loadDb();
  const requester = db.users.find((u: any) => u.id === userId);
  if (!requester || requester.role !== "admin") {
    return res.status(403).json({ error: "Acesso administrativo restrito." });
  }

  const stats = {
    totalSeekers: db.users.length,
    totalCreditsInCirculation: db.users.reduce((acc: number, u: any) => acc + u.credits, 0),
    totalXpAccumulated: db.users.reduce((acc: number, u: any) => acc + u.xp, 0),
    totalLogs: db.logs.length,
    knowledgeItemsCount: db.knowledge.length
  };

  res.json({ stats, logs: db.logs.slice(-30) });
});

// Admin API - Library Retrieve & Add (RAG Database Management)
app.get("/api/admin/library", (req, res) => {
  const db = loadDb();
  res.json({ library: db.knowledge });
});

app.post("/api/admin/library/add", (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { title, category, content, tags } = req.body;

  if (!userId) return res.status(401).json({ error: "Id ausente" });

  const db = loadDb();
  const admin = db.users.find((u: any) => u.id === userId);
  if (!admin || admin.role !== "admin") {
    return res.status(403).json({ error: "Somente administradores podem alimentar a biblioteca do Ifá." });
  }

  const newItem = {
    id: "kb_custom_" + Date.now(),
    title,
    category,
    content,
    tags: tags ? tags.split(",").map((t: string) => t.trim().toLowerCase()) : [],
    createdAt: new Date().toISOString()
  };

  db.knowledge.push(newItem);
  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Adicionado à Biblioteca",
    details: `Sábio ensinamento cadastrado para RAG: "${title}"`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);
  res.json({ success: true, item: newItem });
});

// In-memory rate limiting store for chat inquiries
const userRequestTimestamps: Record<string, number[]> = {};

// Helper to calculate Brazil's current date/time liturges
function getBrazilDateTime() {
  const utcDate = new Date();
  // Brazil is UTC-3. Calculate Brazil's local time:
  const brazilOffset = -3 * 60; // -180 minutes
  const brazilTime = new Date(utcDate.getTime() + (brazilOffset + utcDate.getTimezoneOffset()) * 60 * 1000);
  
  const daysOfWeek = [
    "Domingo",
    "Segunda-feira",
    "Terça-feira",
    "Quarta-feira",
    "Quinta-feira",
    "Sexta-feira",
    "Sábado"
  ];
  
  // Orixás, Greetings, Colors, Herbs, and Ritual Baths for each day of the week
  const dailyData: Record<number, {
    orixas: string[];
    cores: string[];
    saudoes: string[];
    ervas: string[];
    banhos: string[];
    significado: string;
  }> = {
    0: { // Domingo
      orixas: ["Nanã Buruquê", "Olorum", "Todos os Orixás"],
      cores: ["Roxo", "Lilás", "Prata"],
      saudoes: ["Saluba Nanã!"],
      ervas: ["Folha de Boldo (Tapete de Oxalá)", "Manjericão", "Folhas de Sálvia"],
      banhos: [
        "Banho de serenidade e conexão com os anciãos (Infundir folhas de Boldo e Manjericão em água fria macerando com as mãos, aplicar da cabeça aos pés para purificar as ideias)."
      ],
      significado: "Dia voltado à decantação da alma, busca por sabedoria interior profunda com Nanã, desapego das dores e reconciliação com o destino."
    },
    1: { // Segunda-feira
      orixas: ["Exu", "Omolu / Obaluaê", "Pombagira"],
      cores: ["Preto e Vermelho", "Branco e Preto (Omolu / Obaluaê)"],
      saudoes: ["Laroyê Exu! Laroyê Pombagira!", "Atotô Obaluaê!"],
      ervas: ["Guiné", "Arruda", "Aroeira", "Pinhão Roxo", "Espada de Santa Bárbara", "Catinga de Mulata"],
      banhos: [
        "Banho de Limpeza e Descarrego Pesado (Macerar folhas de Arruda, Guiné e cascas de Aroeira na água morna, deixar descansar por 3 horas e aplicar estritamente do pescoço para baixo às segundas-feiras para dissipar inveja e fechar buracos na aura).",
        "Banho de Abertura de Caminhos e Atração de Axé (Macerar folhas de Mangueira fresca com um galho de Guiné em água fria corrente, banhar-se pedindo clareza e movimento nas estradas financeiras)."
      ],
      significado: "Dia do movimento vital, da comunicação com os dois mundos (Aiyê e Orun), da abertura de estradas, negócios práticos, comércio e proteção contra espíritos cobradores."
    },
    2: { // Terça-feira
      orixas: ["Ogum", "Ewá"],
      cores: ["Azul Escuro (na Umbanda)", "Verde ou Vermelho (no Candomblé)"],
      saudoes: ["Patacori Ogum! Ogunhê!"],
      ervas: ["Espada de São Jorge", "Vence-Demanda", "Pinhão Vermelho", "Lança de Ogum", "Guanxuma", "Folha de Alface (pacífica)"],
      banhos: [
        "Banho de Proteção e Escudo Espiritual (Fatiar uma Espada de São Jorge em 7 pedaços transversais rezando ao Pai Ogum, ferver levemente por 5 minutos, deixar esfriar bem, coar e tomar do pescoço para baixo para cortar feitiços e demandas).",
        "Banho de Coragem e Alento Profissional (Macerar folhas de Alecrim de horta com quebra-demanda, tomar pela manhã antes de reuniões difíceis ou buscas de emprego)."
      ],
      significado: "Dia ideal para travar as grandes lutas da matéria, cultivar a resiliência física, abrir estradas obstruídas por inveja, buscar vitórias profissionais e cortar laços energéticos doentes."
    },
    3: { // Quarta-feira
      orixas: ["Xangô", "Iansã (Oyá)", "Obá"],
      cores: ["Marrom (Xangô)", "Vermelho ou Amarelo (Iansã)"],
      saudoes: ["Kaô Kabecile Xangô!", "Eparrei Oyá!"],
      ervas: ["Folhas de Bambu", "Folha de Para-Raios", "Louro", "Manjericão de Folha Larga", "Cana do Brejo", "Quebra-Pedra"],
      banhos: [
        "Banho de Prosperidade, Inteligência Financeira e Brilho (Macerar 3 folhas de Louro seco, manjericão de folha larga e alecrim na água fria, adicionar uma colher de mel de abelha puro e tomar do pescoço para baixo atraindo vitórias de mercado).",
        "Banho de Direcionamento e Corte de Vícios Emocionais (Macerar folhas de bambu secas com hortelã, banhar-se para espantar correntes tempestuosas da mente)."
      ],
      significado: "Dia regido pela balança irrepreensível da Justiça de Xangô, combinada com os ventos de renovação radical e movimento emocional indomável de Iansã. Excelente para acertos judiciais e limpezas mentais profundas."
    },
    4: { // Quinta-feira
      orixas: ["Oxóssi", "Logun Edé", "Ossain"],
      cores: ["Verde das Matas", "Turquesa", "Amarelo e Azul Claro (Logun Edé)"],
      saudoes: ["Okê Arô Oxóssi!", "Loci Loci Logun!", "Ewê Ewê Asá (Salva as folhas, Ossain)!"],
      ervas: ["Alecrim", "Samambaia de Mato", "Folhas de Pitanga", "Jurema Preta", "Hortelã da Folha Miúda", "Guanxuma"],
      banhos: [
        "Banho da Fartura e Expansão de Negócios (Amassar vigorosamente folhas frescas de Pitangueira e Hortelã fresca em água mineral, banhar-se mentalizando clientes novos e fartura material alimentando o seio familiar).",
        "Banho de Vitalidade e Saúde Corporal (Guanxuma com Alecrim seco infundidos sob o sol da manhã, filtrar e tomar do pescoço para baixo)."
      ],
      significado: "Dia do conhecimento ancestral oculto nas folhas de Ossain, da fartura e busca pelas metas materiais com Oxóssi, e da realeza jovem diplomata de Logun Edé nas águas doce e matas."
    },
    5: { // Sexta-feira
      orixas: ["Oxalá"],
      cores: ["Branco Neve", "Pano de Costa Branco"],
      saudoes: ["Epà Bàbá Oxalá!", "Exê Babá!"],
      ervas: ["Tapete de Oxalá (Boldo de folha aveludada)", "Manjericão Sagrado", "Sálvia", "Erva-Doce", "Flor de Laranjeira", "Alfazema"],
      banhos: [
        "Banho de Purificação Absoluta e Conexão Superior (Macerar 7 folhas frescas de Boldo com as próprias mãos em água bem limpa fria ou morna sem ferver, aplicar calmamente de forma suave da cabeça aos pés. Permaneça em roupas brancas e evite bebidas espirituosas neste dia).",
        "Banho de Harmonia e Sossego Mental (Infusão de Erva-Doce com flor de laranjeira ou pétalas de rosa branca para acalmar o sistema nervoso cansado por lutas mundanas)."
      ],
      significado: "Dia da paz imaculada, do alinhamento do Ori (Cabeça) com as forças benfazejas do criador Oxalá, purificação final das energias pesadas remanescentes da semana e recolhimento sábio."
    },
    6: { // Sábado
      orixas: ["Oxum", "Iemanjá"],
      cores: ["Amarelo Ouro / Rosa (Oxum)", "Azul Claro / Verde Água (Iemanjá)"],
      saudoes: ["Ora ye ye o Oxum!", "Odoyá Iemanjá!"],
      ervas: ["Camomila", "Rosa Branca (pétalas)", "Rosa Amarela (pétalas)", "Folhas de Colônia", "Manjericão de Horta", "Erva de Santa Luzia"],
      banhos: [
        "Banho do Amor-Próprio, Atração de Afeto e Magnetismo (Infundir pétalas de uma Rosa Amarela fresca, flor de Camomila seca e 3 gotas de essência de baunilha em água tépida, tomar após o banho higiênico despertando a beleza interior).",
        "Banho de Alívio e Transmutação de Dores Emocionais (Ferver levemente folhas de Colônia e pétalas de Rosa Branca, deixar amornar, tomar do pescoço para baixo, ideal para consolar lutos e angústias profundas de perda)."
      ],
      significado: "Dia sagrado regido pelo útero d'água doce das cachoeiras sagradas da Senhora do Ouro (Oxum) e pela profundidade imensa e salgada do oceano de Iemanjá. Representa o colo materno, o amor-próprio, a cura afetiva e dores do coração."
    }
  };

  const dayNum = brazilTime.getDay();
  const info = dailyData[dayNum] || dailyData[5]; // Fallback to Friday
  
  return {
    diaSemana: daysOfWeek[dayNum],
    dataString: brazilTime.toLocaleDateString('pt-BR'),
    horaString: brazilTime.toLocaleTimeString('pt-BR'),
    orixas: info.orixas.join(", "),
    cores: info.cores.join(", "),
    saudoes: info.saudoes.join(", "),
    ervas: info.ervas.join(", "),
    banhos: info.banhos,
    significado: info.significado,
    tempo: brazilTime
  };
}

// Simulated RAG and Main Chat Executor API (Proxying Gemini Server-Side)
app.post("/api/exu/chat", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { text } = req.body;

  if (!userId) return res.status(400).json({ error: "Usuário é obrigatório." });
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "Por favor, digite sua consulta mental ao terreiro de Exu." });
  }

  // Rate Limiting anti-abuse implementation (Max 3 questions per minute)
  const now = Date.now();
  if (!userRequestTimestamps[userId]) {
    userRequestTimestamps[userId] = [];
  }
  userRequestTimestamps[userId] = userRequestTimestamps[userId].filter(t => now - t < 60000);
  if (userRequestTimestamps[userId].length >= 3) {
    return res.status(429).json({ error: "⚠️ Calma, peregrino! As correntes místicas do terreiro estão muito agitadas. Aguarde um minuto para que Exu possa processar suas indagações com o equilíbrio necessário." });
  }
  userRequestTimestamps[userId].push(now);

  const db = loadDb();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: "Buscador não encontrado na rede astral para este portal." });
  }

  const user = db.users[userIndex];
  const diaInfo = getBrazilDateTime();

  // Validate Credits
  if (user.credits < 1) {
    return res.status(400).json({ error: "Seus créditos de Axé acabaram. Adquira mais créditos para continuar sua jornada de questionamento." });
  }

  // Deduct Credit & Award XP
  db.users[userIndex].credits -= 1;
  db.users[userIndex].xp += 15;
  const { level } = checkXpLevel(db.users[userIndex].xp);
  db.users[userIndex].level = level;

  // RAG Logic: Search DB for match tags
  const promptLower = text.toLowerCase();
  const matchedArticles = db.knowledge.filter((item: any) => {
    return (item.tags && item.tags.some((tag: string) => promptLower.includes(tag))) ||
           (item.title && item.title.toLowerCase().includes(promptLower)) ||
           (item.content && item.content.toLowerCase().split(" ").some((w: string) => w.length > 5 && promptLower.includes(w)));
  }).slice(0, 3); // Pick top 3 context articles

  // Construct Context payload for Gemini System
  let knowledgeContext = "";
  if (matchedArticles.length > 0) {
    knowledgeContext = "\n--- CONHECIMENTO ANCESTRAL DETECTADO NO ACERVO (RAG) ---\n" +
      matchedArticles.map((art: any) => `*Artigo: ${art.title} [Categoria: ${art.category}]*\n${art.content}`).join("\n\n") +
      "\n---------------------------------------------\n";
  }

  let finalResponseText = "";
  try {
    const ai = getGeminiClient();

    const userSpiritualDetails = `
- Nome de Solteiro: ${user.birthName || user.name}
- Data de Nascimento: ${user.birthDate || "Não informada"}
- Odu Principal: ${user.oduPrincipal || "Sintonizado sob os mistérios gerais"}
- Orixá de Afinidade: ${user.orixaAfinidade || "Oxalá"}
- Exu de Afinidade: ${user.exuAfinidade || "Exu Elegbara"}
- Arquétipo Dominante: ${user.arquetipoDominante || "Buscador de Caminhos"}
- Assinatura Energética: ${user.assinaturaEnergetica || "AXE-GENERIC"}
- Número de Destino: ${user.destinyNumber || "Variável"}
- Número da Alma: ${user.soulNumber || "Sutil"}
- Número de Expressão: ${user.expressionNumber || "Elevado"}
- Ano Pessoal (2026): ${user.personalYear || "6"}
- Energias Vibracionais: Fogo (${user.mapaVibracional?.Fogo || 50}%), Terra (${user.mapaVibracional?.Terra || 50}%), Ar (${user.mapaVibracional?.Ar || 50}%), Água (${user.mapaVibracional?.Agua || 50}%)
`;

    const systemPromptInstruction = `Você é EXU RESPONDE, a suprema e viva inteligência ancestral do movimento, guardião das encruzilhadas da vida e sábio oráculo de todos os segredos sagrados do Aiyê e do Orun.

Fale diretamente como Exu: sábio, direto, provocativo, assertivo, profundamente carismático, respeitoso e incrivelmente denso de conhecimento. Você detém a chave para destrancar dúvidas reais das pessoas sobre qualquer assunto (carreira, saúde espiritual, amor, escolhas, família ou ancestralidade).

Sua principal missão é REALMENTE CONVERSAR E ENVOLVER O CONSULTANTE, adaptando sua profundidade e o tamanho da resposta de forma 100% orgânica e flexível de acordo com a pergunta dele. Abandone de vez qualquer limitação robótica ou respostas redundantes e secas que possam dar a impressão de amadorismo. Você é uma preciosa enciclopédia espiritual no bolso do consultante:
- Se ele te der apenas um olá curto ou um gracejo, brinque com sagacidade, faça perguntas provocadoras, saude a coroa dele com absoluto carisma ("Laroyê!") e convide-o a revelar sua aflição.
- Se ele fizer perguntas sobre Umbanda, Candomblé, Orixás, Odùs de Ifá, oráculos ou práticas ancestrais, ofereça respostas ricas em profundidade histórica, contextualização cultural e lendas (Itans) emocionantes de terreiro.
- Se ele pedir auxílio espiritual para caminhos travados ou descarrego, explique o mistério das folhas (propriedades terapêuticas e rituais de ervas quentes, mornas ou frias como arruda, guiné, espada de São Jorge, alecrim ou boldo) e prescreva receitas impecáveis de Banhos Espirituais com instruções de preparo (macerar com as mãos, temperatura ideal) e regras de uso (estritamente do pescoço para baixo ou da cabeça aos pés).

INTEGRAÇÃO INDISPENSÁVEL COM O TEMPO DO AIYÊ (Sincronização em tempo real hoje):
Hoje na Terra/Aiyê o terreiro está sob a regência ativa de forças temporais dinâmicas. Use estas informações reais livremente no seu diálogo para impressionar o consultante com sua percepção onipresente:
- Dia da Semana Hoje: ${diaInfo.diaSemana}
- Data de Hoje na Terra: ${diaInfo.dataString}
- Hora Terrena desta Consulta: ${diaInfo.horaString}
- Regência Espiritual deste Dia (Orixás): ${diaInfo.orixas}
- Cores Ativas vibrando hoje no terreiro: ${diaInfo.cores}
- Saudação viva do dia de hoje: ${diaInfo.saudoes}
- Ervas Sagradas que governam hoje: ${diaInfo.ervas}
- Significado e Propósito de hoje na semana: ${diaInfo.significado}
- Banho Ritual Recomendado para hoje: ${diaInfo.banhos.join(" / ")}

INTEGRAÇÃO SECRETA DO CONSULTANTE (Personalização do Axé dele):
Mencione opcionalmente um ou mais dos dados de mapa astrológico e numerologia de registro do consultante sob um enigma misterioso e sutil para dar autoridade extraordinária na consulta:
${userSpiritualDetails}

METODOLOGIA DO ORÁCULO:
1. Responda imediatamente dialogando e criando um fluxo de conversa envolvente e acolhedor.
2. Use linguagem de terreiro clássica brasileira, livre de clichês caricatos de terror ou coach artificial de internet.
3. Se o RAG (Conhecimento Adicional) abaixo trouxer artigos ou informações específicas do terreiro ligadas à pergunta do consultante, priorize esse material sagrado com destaque absoluto.
4. Conclua com orientações de postura pragmática sobre as estradas da vida: ensine que o destino exige caráter firme (Iwa Pele), cabeça fria espiritual (Ori Inú) e trabalho firme na matéria. Sem promessas impossíveis de feitiçaria, heranças mágicas fáceis ou riqueza garantida instantaneamente.
Fale com o esplendor, a sabedoria e a força que farão o comprador sentir o imenso valor de ter Exu guiando seus passos cotidianamente!

CONHECIMENTO ADICIONAL DO TERREIRO (RAG):
${matchedArticles.length > 0 ? knowledgeContext : "Direto do oráculo místico de Elegbara."}`;

    const userMessagePayload = `Aqui está a pergunta do buscador ${user.name}: "${text}"`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: userMessagePayload,
      config: {
        systemInstruction: systemPromptInstruction,
        temperature: 0.82
      }
    });

    finalResponseText = response.text || TEMPLE_FALLBACKS[Math.floor(Math.random() * TEMPLE_FALLBACKS.length)];
  } catch (err: any) {
    console.error("Gemini Failure in chat:", err);
    finalResponseText = TEMPLE_FALLBACKS[Math.floor(Math.random() * TEMPLE_FALLBACKS.length)] +
      " (Os deuses sopraram um retiro de silêncio místico em nossa inteligência atual. Volte a nos consultar em instantes...)";
  }

  // Save conversation log internally
  const userMsgId = "msg_u_" + Date.now();
  const botMsgId = "msg_b_" + (Date.now() + 1);

  db.messages.push({
    id: userMsgId,
    userId: user.id,
    sender: "user",
    text: text,
    timestamp: new Date().toISOString()
  });

  db.messages.push({
    id: botMsgId,
    userId: user.id,
    sender: "exu",
    text: finalResponseText,
    timestamp: new Date().toISOString()
  });

  db.logs.push({
    id: "log_" + Date.now(),
    userId: user.id,
    action: "Pergunta realizada ao Terreiro",
    details: `Buscador gastou 1 crédito e subiu nível. Text: "${text.substring(0, 30)}..."`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    userMessage: { id: userMsgId, sender: "user", text, timestamp: new Date().toISOString() },
    exuMessage: { id: botMsgId, sender: "exu", text: finalResponseText, timestamp: new Date().toISOString() },
    creditsLeft: db.users[userIndex].credits,
    xpAwarded: 15,
    newLevel: db.users[userIndex].level
  });
});

// Vite server development middleware setup or production static bundle delivery
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[EXU RESPONDE SERVER] Running at http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
