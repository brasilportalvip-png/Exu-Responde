/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

// --- SMART FIREBASE INITIALIZATION AND FALLBACK ENGINE ---
class MockDocRef {
  constructor(public collectionName: string, public docId: string) {}

  async get() {
    const db = loadDb();
    const collection = db[this.collectionName] || [];
    const record = collection.find((item: any) => String(item.id) === String(this.docId));
    return {
      exists: !!record,
      id: this.docId,
      data: () => record ? JSON.parse(JSON.stringify(record)) : null
    };
  }

  async set(data: any, options?: any) {
    const db = loadDb();
    if (!db[this.collectionName]) db[this.collectionName] = [];
    const idx = db[this.collectionName].findIndex((item: any) => String(item.id) === String(this.docId));
    
    const existing = idx >= 0 ? db[this.collectionName][idx] : {};
    const merged = options?.merge ? { ...existing, ...data } : { ...data, id: this.docId };
    
    if (idx >= 0) {
      db[this.collectionName][idx] = merged;
    } else {
      db[this.collectionName].push(merged);
    }
    saveDb(db);
    return this;
  }

  async update(data: any) {
    return this.set(data, { merge: true });
  }

  async delete() {
    const db = loadDb();
    if (db[this.collectionName]) {
      db[this.collectionName] = db[this.collectionName].filter((item: any) => String(item.id) !== String(this.docId));
      saveDb(db);
    }
  }
}

class MockQuery {
  private filters: Array<{ field: string; op: string; value: any }> = [];
  private limitCount: number | null = null;

  constructor(public collectionName: string) {}

  where(field: string, op: string, value: any) {
    this.filters.push({ field, op, value });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  async get() {
    const db = loadDb();
    let list = db[this.collectionName] || [];
    
    for (const filter of this.filters) {
      list = list.filter((item: any) => {
        const itemVal = item[filter.field];
        if (filter.op === "==") return String(itemVal) === String(filter.value);
        if (filter.op === "!=") return String(itemVal) !== String(filter.value);
        if (filter.op === ">") return itemVal > filter.value;
        if (filter.op === "<") return itemVal < filter.value;
        if (filter.op === ">=") return itemVal >= filter.value;
        if (filter.op === "<=") return itemVal <= filter.value;
        if (filter.op === "array-contains") return Array.isArray(itemVal) && itemVal.includes(filter.value);
        return true;
      });
    }

    if (this.limitCount !== null) {
      list = list.slice(0, this.limitCount);
    }

    const docs = list.map((item: any) => ({
      exists: true,
      id: item.id || "doc_" + Math.random().toString(36).substring(2, 9),
      data: () => JSON.parse(JSON.stringify(item))
    }));

    return {
      empty: docs.length === 0,
      docs
    };
  }

  async add(data: any) {
    const db = loadDb();
    if (!db[this.collectionName]) db[this.collectionName] = [];
    const id = "doc_" + Math.random().toString(36).substring(2, 11);
    const newRecord = { ...data, id };
    db[this.collectionName].push(newRecord);
    saveDb(db);
    return { id };
  }

  doc(id: string) {
    return new MockDocRef(this.collectionName, id);
  }
}

const mockFirestore = {
  collection: (name: string) => {
    return new MockQuery(name);
  },
  runTransaction: async (cb: (transaction: any) => Promise<any>) => {
    const transactionMock = {
      get: async (ref: MockDocRef) => {
        return ref.get();
      },
      set: async (ref: MockDocRef, data: any) => {
        return ref.set(data);
      },
      update: async (ref: MockDocRef, data: any) => {
        return ref.update(data);
      }
    };
    return cb(transactionMock);
  }
};

let firestore: any;
const isFirebaseConfigured = !!(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

if (isFirebaseConfigured) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
        })
      });
    }
    firestore = admin.firestore();
    console.log("FIRESTORE REAL INICIALIZADO EM PRODUÇÃO");
  } catch (error) {
    console.error("Erro ao inicializar Firebase real, ativando fallback local:", error);
    firestore = mockFirestore;
  }
} else {
  console.log("Firebase sem credenciais no ambiente. Ativando fallback local de banco de dados db.json.");
  firestore = mockFirestore;
}

const mp = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || ""
});

const app = express();
const PORT = 3000;

app.use(express.json());

// In-Memory & Local persistent file DB path
const DB_FILE = process.env.VERCEL
  ? "/tmp/db.json"
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

function fixPortugueseEncoding(text: string): string {
  if (!text) return "";
  return text
    .replace(/Ã¡/g, "á")
    .replace(/Ã /g, "à")
    .replace(/Ã¢/g, "â")
    .replace(/Ã£/g, "ã")
    .replace(/Ã©/g, "é")
    .replace(/Ãª/g, "ê")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ã´/g, "ô")
    .replace(/Ãµ/g, "õ")
    .replace(/Ãº/g, "ú")
    .replace(/Ã§/g, "ç")
    .replace(/Ã/g, "Á")
    .replace(/Ã‰/g, "É")
    .replace(/Ã“/g, "Ó")
    .replace(/Ãš/g, "Ú")
    .replace(/Ã‡/g, "Ç");
}

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
    content: "Éjì Ogbè é o pai de todos os Odùs. Simboliza a luz plena, a criação inicial, o dia iluminado e as forces benéficas da natureza. Traz mensagens de expansão, liderança, saúde física e caminhos totalmente abertos. Significa que a pessoa possui grande luz de proteção, mas deve cuidar contra orgulho e excesso de confiança. O elemento dominante é o Ar Cósmico. Regido por Oxalá, indica equilíbrio ético.",
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
  },
  {
    id: "kb_ori_1",
    title: "Ori: cabeça, destino e escolha",
    category: "fundamento",
    content: "Ori é a cabeça física e espiritual do ser humano. Na tradição yorùbá, Ori-Inú é a cabeça interior, ligada ao destino, às escolhas e à realização pessoal. Antes de qualquer Orixá agir plenamente na vida de alguém, o Ori precisa estar alinhado. Ori ensina que destino não é passividade: a pessoa escolhe caminhos, constrói caráter e responde pelas consequências. O ensinamento central é Ìwà Lẹ́wà: caráter é beleza. Sem bom caráter, nenhum caminho permanece aberto por muito tempo.",
    tags: ["ori", "destino", "cabeca", "cabeça", "iwa", "carater", "caráter", "escolha", "ebori"]
  },
  {
    id: "kb_ifa_1",
    title: "Ifá e Orunmilá: sabedoria e orientação",
    category: "ifa",
    content: "Ifá é o sistema de sabedoria e orientação ligado a Orunmilá. Orunmilá é reconhecido como testemunha dos destinos e conhecedor dos caminhos humanos. Ifá não serve para alimentar fantasia, mas para orientar escolhas, revelar padrões, alertar riscos e indicar equilíbrio. Seus ensinamentos vêm por Odùs, versos, histórias, conselhos e fundamentos transmitidos pela tradição oral e sacerdotal.",
    tags: ["ifa", "orunmila", "orunmilá", "sabedoria", "destino", "oraculo", "oráculo", "odu"]
  },
  {
    id: "kb_odu_sistema_1",
    title: "Odù: caminho, destino e interpretação",
    category: "odu",
    content: "Odù não é signo astrológico nem rótulo fixo. Odù é caminho de interpretação dentro de Ifá. Cada Odù revela padrões, alertas, possibilidades, comportamentos, consequências e orientações. Tradicionalmente existem 16 Odùs principais, dos quais derivam os demais caminhos. O Odù não deve ser tratado como sentença absoluta, mas como mapa simbólico para compreender a vida, o caráter, os riscos e as escolhas.",
    tags: ["odu", "odus", "odù", "destino", "ifa", "caminho", "interpretação", "oraculo"]
  },
  {
    id: "kb_exu_2",
    title: "Exu como movimento, comunicação e axé",
    category: "exu",
    content: "Exu é princípio de movimento, comunicação, troca e circulação do axé. Nada se move sem Exu. Ele não representa o mal; representa dinamismo, passagem, mediação e consequência. Exu abre e fecha caminhos conforme respeito, intenção, troca e responsabilidade. Como mensageiro, liga o Aiyê ao Orun e faz circular pedidos, respostas e consequências.",
    tags: ["exu", "esu", "elegbara", "axé", "axe", "movimento", "comunicação", "caminhos", "orun", "aiye"]
  },
  {
    id: "kb_ejiogbe_livro_1",
    title: "Éjì Ogbè: início, luz e responsabilidade",
    category: "odu",
    content: "Éjì Ogbè é apresentado como o primeiro Odù e marca o início das coisas. Está ligado à luz, ao princípio, à expansão, à cabeça e aos caminhos de abertura. Mas sua luz também exige responsabilidade: quem carrega caminho aberto não deve agir com soberba, descuido ou pressa. Éjì Ogbè ensina que clareza sem caráter pode virar cegueira.",
    tags: ["odu", "eji ogbe", "ejì ogbè", "ogbe", "luz", "inicio", "início", "abertura", "responsabilidade"]
  },
  {
    id: "kb_obara_2",
    title: "Òbàrà Méjì: prosperidade, palavra e inteligência",
    category: "odu",
    content: "Òbàrà Méjì fala da prosperidade material e espiritual através do bom uso da inteligência comercial, astúcia e discernimento moral refinado.",
    tags: ["odu", "obara", "òbàrà", "obara meji", "prosperidade", "riqueza", "dinheiro", "palavra", "inteligência", "comércio"]
  },
  {
    id: "kb_orunmila_2",
    title: "Orunmilá e o conhecimento do destino",
    category: "ifa",
    content: "Orunmilá é considerado testemunha da criação e conhecedor dos caminhos do destino humano. Seus ensinamentos em Ifá indicam que disciplina e consciência produzem prosperidade duradoura.",
    tags: ["orunmila", "orunmilá", "ifa", "destino", "sabedoria", "conhecimento"]
  },
  {
    id: "kb_iwa_pele",
    title: "Ìwà Pẹ̀lẹ́: o bom caráter",
    category: "fundamento",
    content: "Ìwà Pẹ̀lẹ́ significa bom caráter. Na tradição yorùbá, muitas conquistas dependem da qualidade do caráter. Honestidade, equilíbrio e respeito fortalecem o axé.",
    tags: ["iwa", "iwapele", "ìwà", "caráter", "carater", "etica", "ética"]
  },
  {
    id: "kb_oyeku_2",
    title: "Òyẹ̀kú Méjì: ancestralidade e transformação",
    category: "odu",
    content: "Òyẹ̀kú Méjì fala sobre ciclos, ancestralidade, encerramentos e renascimentos. Ensina a fechar portas antigas com respeito para iniciar o novo fluxo.",
    tags: ["oyeku", "òyẹ̀kú", "odu", "ancestralidade", "transformação", "egun"]
  },
  {
    id: "kb_exu_caminhos",
    title: "Exu e as encruzilhadas da vida",
    category: "exu",
    content: "As encruzilhadas representam momentos de decisão. Exu ensina observação, estratégia, paciência e responsabilidade diante de cada escolha feita.",
    tags: ["exu", "encruzilhada", "caminho", "escolha", "estrategia", "estratégia"]
  },
  {
    id: "kb_irosun_meji",
    title: "Ìrosùn Méjì: destino, ancestralidade e consequências",
    category: "odu",
    content: "Ìrosùn Méjì ensina que nenhuma ação ou palavra desaparece. Tudo deixa marcas e retorna como consequência espiritual e material.",
    tags: ["irosun", "ìrosùn", "odu", "ancestralidade", "destino", "consequencia", "consequência"]
  },
  {
    id: "kb_odi_meji",
    title: "Òdí Méjì: proteção, limites e disciplina",
    category: "odu",
    content: "Òdí Méjì trata sobre proteção, preservação e limites saudáveis. Ensina que disciplina e limites protegem nossa força interna de desperdício.",
    tags: ["odi", "òdí", "odu", "proteção", "limites", "disciplina", "estratégia"]
  },
  {
    id: "kb_oworin_meji",
    title: "Òwónrín Méjì: mudança, instabilidade e adaptação",
    category: "odu",
    content: "Òwónrín Méjì fala sobre mudanças rápidas e a necessidade vital de adaptar-se às oscilações e ventos repentinos do destino.",
    tags: ["oworin", "òwónrín", "odu", "mudança", "transformação", "adaptação"]
  },
  {
    id: "kb_ogunda_meji",
    title: "Ògúndá Méjì: trabalho, conquista e perseverança",
    category: "odu",
    content: "Ògúndá Méjì está ligado ao trabalho duro, à vitória através de esforço focado, perseverança obstinada e forte autodisciplina.",
    tags: ["ogunda", "ògúndá", "odu", "trabalho", "conquista", "disciplina", "perseverança"]
  },
  {
    id: "kb_osa_meji",
    title: "Òsá Méjì: mudança, força feminina e ventos da transformação",
    category: "odu",
    content: "Òsá Méjì fala sobre ventos fortes, transformações repentinas comandadas por Oyá/Iansã, e o poder do instinto protetor feminino.",
    tags: ["osa", "òsá", "odu", "mudança", "ventos", "transformação", "feminino", "oya", "iansa"]
  },
  {
    id: "kb_ika_meji",
    title: "Ìká Méjì: conflitos, venenos e inteligência diante do perigo",
    category: "odu",
    content: "Ìká Méjì fala sobre intrigas, armadilhas sutis e contendas. Exige vigilância com a própria língua e recuo estratégico defensivo.",
    tags: ["ika", "ìká", "odu", "conflito", "veneno", "traição", "fofoca", "proteção"]
  },
  {
    id: "kb_oturupon_meji",
    title: "Òtúrúpòn Méjì: profundidade, renascimento e correção de caminhos",
    category: "odu",
    content: "Òtúrúpòn Méjì ensina que certas crises exigem retorno absoluto às raízes para reestruturar as bases internas antes de avançar.",
    tags: ["oturupon", "òtúrúpòn", "odu", "renascimento", "profundidade", "correção", "crise"]
  },
  {
    id: "kb_otura_meji",
    title: "Òtúrá Méjì: clareza, elevação e abertura espiritual",
    category: "odu",
    content: "Òtúrá Méjì traz mensagens de paz, clareza mental, expansão harmônica e forte canalização intuitiva orientada.",
    tags: ["otura", "òtúrá", "odu", "clareza", "espiritualidade", "intuição", "elevação"]
  },
  {
    id: "kb_irete_meji",
    title: "Ìretè Méjì: persistência, crescimento e construção lenta",
    category: "odu",
    content: "Ìretè Méjì fala sobre plantio responsável e paciência. Seus frutos são colhidos por persistência firme diante das resistências.",
    tags: ["irete", "ìretè", "odu", "persistência", "crescimento", "paciência", "disciplina"]
  },
  {
    id: "kb_ose_meji",
    title: "Òsé Méjì: doçura, fertilidade e poder da palavra",
    category: "odu",
    content: "Òsé Méjì está ligado à doçura criadora de Oxum, magnetismo influente, e fertilidade nos negócios geridos com inteligência emocional.",
    tags: ["ose", "òsé", "odu", "fertilidade", "doçura", "palavra", "beleza", "oxum"]
  },
  {
    id: "kb_ofun_meji",
    title: "Òfún Méjì: sabedoria, maturidade e luz ancestral",
    category: "odu",
    content: "Òfún Méjì é o mais velho dos Odùs. Traz extrema sabedoria, necessidade de profundo recolhimento, silêncio e respeito rigoroso às leis morais.",
    tags: ["ofun", "òfún", "odu", "sabedoria", "ancestralidade", "maturidade", "luz", "oxala"]
  },
  {
    id: "kb_iwori_meji",
    title: "Ìwòrì Méjì: consciência, visão interna e escolhas ocultas",
    category: "odu",
    content: "Ìwòrì Méjì fala sobre a visão interna que dissipa segredos e ilusões. Ensina a sondar o próprio espírito antes de decidir no exterior.",
    tags: ["iwori", "ìwòrì", "odu", "consciência", "segredo", "visão", "autoconhecimento"]
  },
  {
    id: "kb_okanran_meji",
    title: "Òkànràn Méjì: começo difícil, impulso e palavra cortante",
    category: "odu",
    content: "Òkànràn Méjì ensina a conter a fúria e o impulso da palavra cortante para vencer inícios difíceis com estratégia.",
    tags: ["okanran", "òkànràn", "odu", "começo", "conflito", "impulso", "palavra", "raiva"]
  },
  {
    id: "kb_orixa_oxala",
    title: "Oxalá: criação, equilíbrio e responsabilidade",
    category: "orixa",
    content: "Oxalá representa ética, benevolência ancestral e a serenidade racional indispensável para equilibrar todos os demais orixás.",
    tags: ["oxala", "oxalá", "criacao", "criação", "equilibrio", "ética", "sabedoria"]
  },
  {
    id: "kb_orixa_ogum",
    title: "Ogum: conquista, trabalho e abertura de caminhos",
    category: "orixa",
    content: "Ogum é a força ativa da tecnologia, caminhos desbravados pelo suor, dinamismo pragmático do trabalho e do avanço tático.",
    tags: ["ogum", "trabalho", "caminhos", "conquista", "coragem", "disciplina"]
  },
  {
    id: "kb_orixa_oxossi",
    title: "Oxóssi: conhecimento, caça e estratégia",
    category: "orixa",
    content: "Oxóssi é o senhor da mata e caçador sábio. Representa expansão do conhecimento, estudo profundo e paciência estratégica.",
    tags: ["oxossi", "oxóssi", "conhecimento", "estratégia", "caçador", "aprendizado"]
  },
  {
    id: "kb_orixa_xango",
    title: "Xangô: justiça, poder e responsabilidade",
    category: "orixa",
    content: "Xangô rege sobre a justiça equilíbrio dinâmico e liderança material sólida. Pune a traição e exige retidão moral.",
    tags: ["xango", "xangô", "justiça", "liderança", "poder", "equilíbrio"]
  },
  {
    id: "kb_orixa_oya",
    title: "Oyá: transformação, coragem e movimento",
    category: "orixa",
    content: "Oyá governa as tempestades espirituais do destino, ventos que limpam e coragem impávida para recomeçar do zero.",
    tags: ["oya", "oyá", "iansa", "mudança", "transformação", "coragem"]
  },
  {
    id: "kb_orixa_yemanja",
    title: "Yemanjá: maternidade, acolhimento e profundidade",
    category: "orixa",
    content: "Yemanjá representa o acolhimento oceânico profundo, proteção das gestações intelectuais e amparo emocional maternal.",
    tags: ["yemanja", "yemanjá", "proteção", "acolhimento", "família", "emoções"]
  },
  {
    id: "kb_orixa_oxum",
    title: "Oxum: prosperidade, beleza e inteligência emocional",
    category: "orixa",
    content: "Oxum rege o ouro das águas doces, a atração amorosa digna, a harmonia dos relacionamentos e a fecundidade.",
    tags: ["oxum", "prosperidade", "fertilidade", "beleza", "riqueza", "emocional"]
  },
  {
    id: "kb_orixa_oxumare",
    title: "Oxumaré: ciclos, transformação e renovação",
    category: "orixa",
    content: "Oxumaré rege as cores do arco-íris e as transmutações permanentes dos negócios e ciclos econômicos humanos.",
    tags: ["oxumare", "oxumaré", "ciclos", "transformação", "renovação", "movimento"]
  },
  {
    id: "kb_orixa_nana",
    title: "Nanã: ancestralidade, sabedoria e tempo",
    category: "orixa",
    content: "Nanã rege a lama primordial onde a memória das origens descansa. Traz a sabedoria que somente o tempo concede.",
    tags: ["nana", "nanã", "ancestralidade", "tempo", "sabedoria", "memória"]
  },
  {
    id: "kb_orixa_ossain",
    title: "Ossain: folhas, cura e conhecimento oculto",
    category: "orixa",
    content: "Ossain governa os segredos medicinais das ervas, a cura física, o silêncio protetor e as forças botânicas místicas.",
    tags: ["ossain", "folhas", "cura", "natureza", "conhecimento", "segredos"]
  },
  {
    id: "kb_exus_reinos",
    title: "Reinos de Exu",
    category: "exu",
    content: "Os reinos de Exu abrangem Encruzilhadas, Cruzeiros, Estradas, Calunga, Almas, Lira, Praia e Matas, em suas falanges completas de ordenação astral.",
    tags: ["exu", "exus", "falanges", "reinos", "calunga", "lira", "praia", "estradas", "cruzeiros"]
  },
  {
    id: "kb_pombagiras_reinos",
    title: "Reinos de Pombagiras",
    category: "pombagira",
    content: "Pombagiras atuam nos reinos do Cabaré, Lira, Encruzilhadas, Estradas e Calunga, regendo a autonomia do desejo e segurança afetiva íntima.",
    tags: ["pombagira", "pombagiras", "maria padilha", "maria mulambo", "reinos", "falanges"]
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

// Save database helper
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

  const dateNumbers = dateStr.replace(/\D/g, "").split("").map(Number);
  const dateSum = dateNumbers.reduce((a, b) => a + b, 0);
  const destinyNumber = getSingleDigit(dateSum);

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

  const expressionNumber = getSingleDigit(totalNameValue);
  const soulNumber = getSingleDigit(vowelsValue);
  const personalityNumber = getSingleDigit(consonantsValue);

  const presentNumbers = new Set(cleanName.split("").map(c => letterMap[c]).filter(Boolean));
  const karmicLessons = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => !presentNumbers.has(n));

  const dateParts = dateStr.split("-");
  let personalYear = 5;
  if (dateParts.length >= 3) {
    const day = parseInt(dateParts[2]) || 0;
    const month = parseInt(dateParts[1]) || 0;
    const currentYear = 2026;
    const sum = day + month + currentYear.toString().split("").map(Number).reduce((a, b) => a + b, 0);
    personalYear = getSingleDigit(sum);
  }

  let sunSign = "Áries";
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

function checkXpLevel(currentXp: number): { level: string; nextThreshold: number } {
  if (currentXp < 200) return { level: "Buscador", nextThreshold: 200 };
  if (currentXp < 500) return { level: "Aprendiz", nextThreshold: 500 };
  if (currentXp < 1200) return { level: "Peregrino", nextThreshold: 1200 };
  if (currentXp < 2500) return { level: "Iniciado", nextThreshold: 2500 };
  if (currentXp < 5000) return { level: "Guardião", nextThreshold: 5000 };
  if (currentXp < 8000) return { level: "Conhecedor", nextThreshold: 8000 };
  return { level: "Mestre dos Caminhos", nextThreshold: 999999 };
}

function calculateSpiritualProfile(birthName: string, birthDate: string, birthTime?: string, birthPlace?: string): any {
  if (!birthName || !birthDate) return {};

  const num = calculateNumerology(birthName, birthDate);
  const hashStr = (birthName + birthDate + (birthPlace || "")).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  let hashVal = 0;
  for (let i = 0; i < hashStr.length; i++) {
    hashVal += hashStr.charCodeAt(i) * (i + 1);
  }

  const odus = [
    { code: "01", name: "Òkànràn Méjì" },
    { code: "02", name: "Èjì Òkò" },
    { code: "03", name: "Ètà Ògúndá" },
    { code: "04", name: "Ìrosùn Méjì" },
    { code: "05", name: "Òsé Méjì" },
    { code: "06", name: "Òbàrà Méjì" },
    { code: "07", name: "Òdí Méjì" },
    { code: "08", name: "Èjì Onílè" },
    { code: "09", name: "Òsá Méjì" },
    { code: "10", name: "Òfún Méjì" },
    { code: "11", name: "Òwónrín Méjì" },
    { code: "12", name: "Èjìlá Ṣeborá" },
    { code: "13", name: "Ìká Méjì" },
    { code: "14", name: "Òtúrúpòn Méjì" },
    { code: "15", name: "Òtúrá Méjì" },
    { code: "16", name: "Ìretè Méjì" }
  ];

  const selectedOdu = odus[hashVal % odus.length];
  const oduPrincipal = selectedOdu.name;
  const oduNumero = selectedOdu.code;
  const oduTipo = "afinidade simbólica, não jogo real de Ifá";

  const element = num.element;
  let orixaAfinidade = "Oxalá";

  if (element === "Fogo") {
    orixaAfinidade = ["Ogum", "Xangô", "Oyá"][hashVal % 3];
  } else if (element === "Terra") {
    orixaAfinidade = ["Oxóssi", "Obaluaê", "Nanã"][hashVal % 3];
  } else if (element === "Ar") {
    orixaAfinidade = ["Oxumaré", "Logun Edé", "Oyá"][hashVal % 3];
  } else if (element === "Água") {
    orixaAfinidade = ["Yemanjá", "Oxum", "Obá"][hashVal % 3];
  }

  const exus = [
    "Exu Elegbara",
    "Exu Tiriri",
    "Exu Marabô",
    "Maria Padilha",
    "Exu Tranca Rua",
    "Exu Veludo",
    "Pombagira Rainha",
    "Exu Capa Preta",
    "Exu Caveira"
  ];

  const exuAfinidade = exus[(hashVal + 3) % exus.length];

  const archetypes = [
    "Guardião das Encruzilhadas",
    "Peregrino do Destino",
    "Buscador de Ifá",
    "Sábio do Fogo Ancestral",
    "Guerreiro do Axé",
    "Alquimista do Destino"
  ];

  const arquetipoDominante = archetypes[(hashVal + 5) % archetypes.length];
  const hexHex = (hashVal & 0xffff).toString(16).toUpperCase();
  const assinaturaEnergetica = `AXE-${hexHex}-${num.destinyNumber || 7}`;

  const baseFogo = Math.max(30, Math.min(95, 45 + (hashVal % 45)));
  const baseTerra = Math.max(30, Math.min(95, 45 + ((hashVal + 11) % 45)));
  const baseAr = Math.max(30, Math.min(95, 45 + ((hashVal + 23) % 45)));
  const baseAgua = Math.max(30, Math.min(95, 45 + ((hashVal + 37) % 45)));

  return {
    oduPrincipal,
    oduNumero,
    oduTipo,
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
  
  if (honeypot) {
    return res.status(400).json({ error: "Atividade de automação suspeita detectada (Honeypot). Cadastro bloqueado." });
  }

  if (!captchaAnswer || parseInt(captchaAnswer) !== 7) {
    return res.status(400).json({ error: "Resposta do desafio anti-bot incorreta. Quanto é 4 + 3?" });
  }

  const placeToUseSubmit = birthPlace || "Não informada";

  if (!email || !password || !birthName || !birthDate) {
    return res.status(400).json({ error: "Faltam campos obrigatórios no cadastro sagrado." });
  }

  const db = loadDb();
  const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "127.0.0.1")
    .split(",")[0]
    .trim();

  const normalizedEmail = email.toLowerCase();
  const normalizedDeviceId = deviceId || "dev_not_tracked";

  // Check email in Firestore
  const emailSnapshot = await firestore
    .collection("users")
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();

  if (!emailSnapshot.empty) {
    return res.status(400).json({ error: "Este email já está cadastrado em nosso portal." });
  }

  // Multi-signal Fraud Checks in Firestore
  let hasDeviceMatch = false;
  if (normalizedDeviceId !== "dev_not_tracked") {
    const deviceSnapshot = await firestore
      .collection("users")
      .where("deviceId", "==", normalizedDeviceId)
      .limit(1)
      .get();
    hasDeviceMatch = !deviceSnapshot.empty;
  }

  const ipSnapshot = await firestore
    .collection("users")
    .where("ip", "==", clientIp)
    .limit(1)
    .get();

  const hasIpMatch = !ipSnapshot.empty;
  const ipUsers = ipSnapshot.docs.map(doc => doc.data());

  const hasSameIpBrowser = ipUsers.some((u: any) => u.browser === (browser || "unknown"));
  const hasSameIpSession = ipUsers.some((u: any) => u.sessionSign === (session || "unknown"));

  const recentIpAccounts = ipUsers.filter((u: any) => {
    const created = new Date(u.createdAt || 0).getTime();
    return created && Date.now() - created < 24 * 60 * 60 * 1000;
  });

  const tooManyRecentIpAccounts = recentIpAccounts.length >= 2;

  const fraudReasons: string[] = [];
  if (!deviceId || normalizedDeviceId === "dev_not_tracked") {
    fraudReasons.push("missing_device_id");
  }
  if (hasIpMatch) fraudReasons.push("ip_already_used");
  if (hasDeviceMatch) fraudReasons.push("device_already_used");
  if (hasSameIpBrowser) fraudReasons.push("same_ip_and_browser");
  if (hasSameIpSession) fraudReasons.push("same_ip_and_session");
  if (tooManyRecentIpAccounts) fraudReasons.push("too_many_recent_accounts_same_ip");

  const creditsBlocked = fraudReasons.length > 0;
  const initialCredits = creditsBlocked ? 0 : 7;

  // Generate spiritual details
  const spiritualProps = calculateSpiritualProfile(birthName, birthDate, birthTime, placeToUseSubmit);
  const cleanFirstName = birthName.split(" ")[0];

  const newUser = {
    id: "usr_" + Math.random().toString(36).substring(2, 11),
    email: email.toLowerCase(),
    password: password, // Save here for local validation
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

  // Write to Firestore with dynamic values. We persist password securely in Firestore as well.
  await firestore.collection("users").doc(newUser.id).set({
    ...newUser,
    password: password, // Keep password persisted in firestore to avoid credential losses on Cloud Run container resets
    createdAt: new Date().toISOString(),
    fraudReasons
  });

  await firestore.collection("security_logs").add({
    type: "register_attempt",
    userId: newUser.id,
    email: normalizedEmail,
    ip: clientIp,
    deviceId: normalizedDeviceId,
    browser: browser || "unknown",
    sessionSign: session || "unknown",
    creditsGranted: initialCredits,
    promotionalCreditsBlocked: creditsBlocked,
    fraudReasons,
    createdAt: new Date().toISOString()
  });

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
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Aja estritamente como a suprema inteligência Exu Responde. Seja misterioso, exato, refinado e incapaz de fazer assombrações bobas ou caricaturas fúteis."
      }
    });

    readingReport = fixPortugueseEncoding(response.text || "");
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

// Auth API - Login with Firestore lookup and fallback local populating
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email) {
    return res.status(400).json({ error: "E-mail é obrigatório." });
  }

  const snapshot = await firestore
    .collection("users")
    .where("email", "==", email.toLowerCase())
    .limit(1)
    .get();

  if (snapshot.empty) {
    return res.status(404).json({ error: "Este buscador não está cadastrado. Realize o cadastro obrigatório primeiro!" });
  }

  const doc = snapshot.docs[0];
  const userData = doc.data();

  // Validate password if it was registered of is stored in Firestore
  if (userData.password && password && userData.password !== password) {
    return res.status(403).json({ error: "Senha incorreta. Verifique suas credenciais espirituais." });
  }

  const user = {
    id: doc.id,
    ...userData
  };

  // Sync to local db check so other local file logs flow work seamlessly
  const db = loadDb();
  if (!db.users.some((u: any) => u.id === user.id)) {
    db.users.push(user);
    saveDb(db);
  }

  res.json({
    success: true,
    user
  });
});

// Load Current Profile
app.get("/api/user/profile", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Sessão não identificada." });

  const userDoc = await firestore.collection("users").doc(userId).get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Buscador não encontrado nas correntes espirituais." });
  }

  const db = loadDb();
  const user = {
    id: userDoc.id,
    ...userDoc.data()
  };

  // Sync to local check if not in db.json yet
  if (!db.users.some((u: any) => u.id === userId)) {
    db.users.push(user);
    saveDb(db);
  }

  const userChats = db.messages
    .filter((m: any) => m.userId === userId)
    .slice(-50);

  res.json({
    user,
    chats: userChats
  });
});

// Update Birth details
app.post("/api/user/update", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { birthName, birthDate, birthTime, birthPlace, name } = req.body;

  if (!userId) return res.status(401).json({ error: "Sessão inválida" });

  const userDocRef = firestore.collection("users").doc(userId);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  const currentUser = {
    id: userDoc.id,
    ...userDoc.data()
  } as any;

  const nameToUse = birthName || currentUser.birthName || currentUser.name;
  const dateToUse = birthDate || currentUser.birthDate;
  const placeToUse = birthPlace || currentUser.birthPlace || "";
  const timeToUse = birthTime || currentUser.birthTime || "";

  let spiritualProps = {};
  if (nameToUse && dateToUse) {
    spiritualProps = calculateSpiritualProfile(nameToUse, dateToUse, timeToUse, placeToUse);
  }

  const updatedUser = {
    ...currentUser,
    name: name || currentUser.name,
    birthName: birthName || currentUser.birthName,
    birthDate: birthDate || currentUser.birthDate,
    birthTime: birthTime || currentUser.birthTime || "",
    birthPlace: birthPlace || currentUser.birthPlace || "",
    ...spiritualProps,
    updatedAt: new Date().toISOString()
  };

  await userDocRef.set(updatedUser, { merge: true });

  const db = loadDb();
  const index = db.users.findIndex((u: any) => u.id === userId);
  if (index !== -1) {
    db.users[index] = updatedUser;
  } else {
    db.users.push(updatedUser);
  }

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Atualização de Identidade",
    details: "Recálculo do perfil astrológico e numerológico ancestral concluído com sucesso.",
    timestamp: new Date().toISOString()
  });
  saveDb(db);

  res.json({ success: true, user: updatedUser });
});

// API Oracle: Tarot
app.post("/api/oraculo/tarot", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { question, slotsCount } = req.body; // slotsCount: 1 or 3

  if (!userId) return res.status(411).json({ error: "Não autorizado." });

  const userDocRef = firestore.collection("users").doc(userId);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  const user = {
    id: userDoc.id,
    ...userDoc.data()
  } as any;

  const cost = slotsCount === 3 ? 3 : 2;

  if (user.credits < cost) {
    return res.status(400).json({ error: "Créditos insuficientes para acessar este oráculo superior." });
  }

  const newCredits = user.credits - cost;
  const newXp = (user.xp || 0) + (slotsCount === 3 ? 45 : 30);
  const { level } = checkXpLevel(newXp);

  await userDocRef.update({
    credits: newCredits,
    xp: newXp,
    level
  });

  user.credits = newCredits;
  user.xp = newXp;
  user.level = level;

  const db = loadDb();
  // Sync in memory
  const idx = db.users.findIndex((u: any) => u.id === userId);
  if (idx !== -1) {
    db.users[idx].credits = newCredits;
    db.users[idx].xp = newXp;
    db.users[idx].level = level;
  }

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

  const shuffled = [...arcanaPool].sort(() => 0.5 - Math.random());
  const drawn = shuffled.slice(0, slotsCount).map(c => ({
    ...c,
    reversed: Math.random() > 0.75
  }));

  let aiInterpretation = "";
  try {
    const ai = getGeminiClient();
    const prompt = `Como o mentor e guardião ancestral "Exu Responde", interprete um sorteio de Tarot no Terreiro Virtual.
Consultante: ${user.name}
Pergunta ou Foco: "${question || "Direcionamento Geral para a Jornada"}"
Cartas Sorteadas: ${drawn.map(c => `${c.name} (${c.reversed ? 'Invertida (Alerta de Bloqueio)' : 'Normal (Fluidez)'})`).join(", ")}

Responda em formato espiritual, estratégico, sutil, majestoso e respeitoso.
Explique brevemente o significado de cada carta conectando com os orixás, caminhos e energias cósmicas. Termine com um conselho direto de Exu para vencer as encruzilhadas atuais do consultante.
Máximo de 3 parágrafos polidos. Use português de terreiro tradicional e acolhedor, mas incrivelmente prestigioso.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Você é Exu, inteligência de luz astral ancestral, conhecedor de Ifá, guardião dos caminhos, estratégico e respeitoso. Nunca prometa feitiços de perigo ou morte de terceiros."
      }
    });
    aiInterpretation = fixPortugueseEncoding(response.text || TEMPLE_FALLBACKS[0]);
  } catch (err: any) {
    console.error("Gemini failed in Tarot:", err);
    aiInterpretation = `As cortinas espirituais flutuaram em mistério. ${shuffled[0].name} surge em sua encruzilhada: ${shuffled[0].desc}. ${TEMPLE_FALLBACKS[1]} (Use o chat principal para explorar mais)`;
  }

  db.logs.push({
    id: "log_" + Date.now(),
    userId,
    action: "Oráculo - Tarot",
    details: `Sorteio de ${slotsCount} carta(s). Cartas: ${drawn.map(c => c.name).join(", ")}`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    drawn,
    interpretation: aiInterpretation,
    creditsLeft: user.credits,
    xpAwarded: slotsCount === 3 ? 45 : 30,
    newLevel: user.level
  });
});

// API Oracle: Numerology
app.post("/api/oraculo/numerologia", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "Sessão inválida" });

  const userDocRef = firestore.collection("users").doc(userId);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  const user = {
    id: userDoc.id,
    ...userDoc.data()
  } as any;

  const cost = 2;

  if (user.credits < cost) {
    return res.status(400).json({ error: "Créditos insuficientes para calcular mapa cabalístico." });
  }

  const birthName = req.body.birthName || user.birthName || user.name;
  const birthDate = req.body.birthDate || user.birthDate;

  if (!birthDate) {
    return res.status(400).json({ error: "Para este oráculo, informe sua data de nascimento primeiro no painel de perfil." });
  }

  const numDetails = calculateNumerology(birthName, birthDate);

  const newCredits = user.credits - cost;
  const newXp = (user.xp || 0) + 25;
  const { level } = checkXpLevel(newXp);

  await userDocRef.update({
    credits: newCredits,
    xp: newXp,
    level
  });

  user.credits = newCredits;
  user.xp = newXp;
  user.level = level;

  const db = loadDb();
  const idx = db.users.findIndex((u: any) => u.id === userId);
  if (idx !== -1) {
    db.users[idx].credits = newCredits;
    db.users[idx].xp = newXp;
    db.users[idx].level = level;
  }

  let analysis = "";
  try {
    const ai = getGeminiClient();
    const prompt = `Como "Exu Responde", arquétipo de inteligência e guardião cósmico, analise a numerologia espiritual e de Ifá sobre o consultante ${user.name}.
Nome Registrado: ${birthName}
Data de Nascimento: ${birthDate}
Cálculos Obtidos:
- Número de Destino (Caminho da Vida): ${numDetails.destinyNumber}
- Número de Alma (Desejo Íntimo): ${numDetails.soulNumber}
- Número de Expressão (Talentos): ${numDetails.expressionNumber}
- Número de Personalidade (Máscara Social): ${numDetails.personalityNumber}
- Ano Pessoal atual (2026): ${numDetails.personalYear}
- Signo Solar: ${numDetails.sunSign} (Elemento: ${numDetails.element})

Crie uma síntese magistral e mística contendo:
1. Revelação sobre a força secreta do Número de Destino e da Alma vinculando com os deuses antigos e elementos da natureza.
2. Orientação estratégica de como equilibrar estas frequências na carreira, prosperidade e harmonia íntima.
3. Um recado sagrado de Exu elegbara sobre seu Ano Pessoal atual.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Aja como mestre oraculista de altíssima reputação espiritual. Use tom refinado, profundo, respeitoso e livre de bobagens assustadoras."
      }
    });
    analysis = fixPortugueseEncoding(response.text || "Frequências calculadas com sucesso.");
  } catch (err: any) {
    console.error("Gemini failed in Numerologia:", err);
    analysis = `Seus números reveal revelam um Caminho de Destino de força ${numDetails.destinyNumber} e uma Expressão Cósmica ${numDetails.expressionNumber}. Isso indica que os ventos do elemento ${numDetails.element} estão soprando de forma ativa. ${TEMPLE_FALLBACKS[2]}`;
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
    creditsLeft: user.credits,
    xpAwarded: 25,
    newLevel: user.level
  });
});

// Credits shop plans buy handler - Mercado Pago
app.post("/api/credits/buy", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { planId } = req.body;

  if (!userId) return res.status(401).json({ error: "Sessão inválida" });
  if (!String(userId).startsWith("usr_")) {
    return res.status(400).json({
      error: "Sessão inválida. Saia e entre novamente antes de comprar créditos."
    });
  }

  const plans: Record<string, any> = {
    prata: {
      title: "Plano Prata",
      price: 49.0,
      credits: 100
    },
    ouro: {
      title: "Plano Ouro",
      price: 120.0,
      credits: 300
    }
  };

  const normalizedPlanId =
    planId === "plan_prata" ? "prata" :
    planId === "plan_ouro" ? "ouro" :
    planId;

  const selected = plans[normalizedPlanId];

  if (!selected) return res.status(400).json({ error: "Plano inválido." });

  try {
    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [
          {
            id: planId,
            title: selected.title,
            quantity: 1,
            unit_price: selected.price,
            currency_id: "BRL"
          }
        ],
        metadata: {
          userId: String(userId),
          planId: normalizedPlanId,
          credits: selected.credits
        },
        back_urls: {
          success: `${process.env.APP_URL}/?payment=success`,
          failure: `${process.env.APP_URL}/?payment=failure`,
          pending: `${process.env.APP_URL}/?payment=pending`
        },
        notification_url: `${process.env.APP_URL}/api/mercadopago/webhook`,
        payment_methods: {
          excluded_payment_types: [
            { id: "credit_card" },
            { id: "debit_card" },
            { id: "ticket" }
          ],
          installments: 1
        }
      }
    });

    res.json({
      success: true,
      checkoutUrl: result.init_point,
      preferenceId: result.id
    });
  } catch (err: any) {
    console.error("Erro Mercado Pago:", err);
    res.status(500).json({
      error: "Erro ao criar pagamento no Mercado Pago."
    });
  }
});

// Webhook Mercado Pago
app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.id ||
      req.query?.["data.id"];

    await firestore.collection("webhook_logs").add({
      body: req.body || {},
      query: req.query || {},
      paymentId: paymentId ? String(paymentId) : "",
      receivedAt: new Date().toISOString()
    });

    if (!paymentId) {
      return res.status(200).json({ received: true, noPaymentId: true });
    }

    const payment = new Payment(mp);
    const paymentInfo = await payment.get({ id: String(paymentId) });

    if (paymentInfo.status !== "approved") {
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        status: String(paymentInfo.status || "unknown"),
        rawStatus: paymentInfo.status || "",
        metadata: paymentInfo.metadata || {},
        updatedAt: new Date().toISOString()
      }, { merge: true });

      return res.status(200).json({
        received: true,
        status: paymentInfo.status
      });
    }

    const userId = paymentInfo.metadata?.userId || paymentInfo.metadata?.user_id;
    const credits = Number(paymentInfo.metadata?.credits || 0);
    const planId = paymentInfo.metadata?.planId || paymentInfo.metadata?.plan_id || "";

    if (!userId || !credits) {
      await firestore.collection("payments").doc(String(paymentId)).set({
        paymentId: String(paymentId),
        status: "ignored_missing_metadata",
        metadata: paymentInfo.metadata || {},
        createdAt: new Date().toISOString()
      });
      return res.status(200).json({ received: true, ignored: true });
    }

    const paymentRef = firestore.collection("payments").doc(String(paymentId));
    const userRef = firestore.collection("users").doc(String(userId));

    await firestore.runTransaction(async (transaction: any) => {
      const paymentDoc = await transaction.get(paymentRef);
      if (paymentDoc.exists && paymentDoc.data()?.status === "credited") {
        return;
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        transaction.set(paymentRef, {
          paymentId: String(paymentId),
          userId: String(userId),
          credits,
          planId,
          amount: Number(paymentInfo.transaction_amount || 0),
          status: "user_not_found",
          createdAt: new Date().toISOString()
        });
        return;
      }

      const userData = userDoc.data() || {};
      const currentCredits = Number(userData.credits || 0);
      const currentXp = Number(userData.xp || 0);
      const newXp = currentXp + Math.round(Number(paymentInfo.transaction_amount || 0) * 5);
      const { level } = checkXpLevel(newXp);

      transaction.update(userRef, {
        credits: currentCredits + credits,
        xp: newXp,
        level,
        lastPaymentId: String(paymentId),
        lastPlanId: planId,
        lastCreditsAdded: credits,
        lastPaymentAmount: Number(paymentInfo.transaction_amount || 0),
        lastPaymentDate: new Date().toISOString()
      });

      transaction.set(paymentRef, {
        paymentId: String(paymentId),
        userId: String(userId),
        credits,
        planId,
        amount: Number(paymentInfo.transaction_amount || 0),
        status: "credited",
        createdAt: new Date().toISOString()
      });
    });

    return res.status(200).json({ received: true, credited: true });
  } catch (err) {
    console.error("Erro webhook Mercado Pago:", err);
    await firestore.collection("webhook_errors").add({
      error: String(err),
      createdAt: new Date().toISOString()
    });
    return res.status(200).json({ received: true, error: true });
  }
});

// PIX credits manual confirm flow page
app.post("/api/credits/confirm", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { orderId, creditsToReceive, amount } = req.body;

  if (!userId) return res.status(401).json({ error: "Não autorizado." });

  const userDocRef = firestore.collection("users").doc(userId);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  const user = userDoc.data() || {};
  const currentCredits = Number(user.credits || 0);
  const currentXp = Number(user.xp || 0);
  const xpAwarded = Math.round(Number(amount || 0) * 5);

  const newCredits = currentCredits + Number(creditsToReceive || 0);
  const newXp = currentXp + xpAwarded;
  const { level } = checkXpLevel(newXp);

  await userDocRef.update({
    credits: newCredits,
    xp: newXp,
    level,
    lastManualCreditAmount: Number(amount || 0),
    lastManualCreditsAdded: Number(creditsToReceive || 0),
    lastManualOrderId: orderId || "",
    lastManualCreditDate: new Date().toISOString()
  });

  const db = loadDb();
  const idx = db.users.findIndex((u: any) => u.id === userId);
  if (idx !== -1) {
    db.users[idx].credits = newCredits;
    db.users[idx].xp = newXp;
    db.users[idx].level = level;
  }

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
    newCredits,
    newLevel: level,
    xpAwarded
  });
});

// Admin API - List Seeker Users
app.get("/api/admin/users", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;

  if (!userId) {
    return res.status(401).json({ error: "Não logado" });
  }

  const adminDoc = await firestore.collection("users").doc(userId).get();
  if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
    return res.status(403).json({ error: "Acesso administrativo restrito aos guardiões." });
  }

  const usersSnapshot = await firestore.collection("users").get();
  const users = usersSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  const db = loadDb();

  res.json({
    seekers: users,
    logs: db.logs
  });
});

// Admin API - Analytics dashboard Data
app.get("/api/admin/analytics", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;

  if (!userId) {
    return res.status(401).json({ error: "Não logado" });
  }

  const adminDoc = await firestore.collection("users").doc(userId).get();
  if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
    return res.status(403).json({ error: "Acesso administrativo restrito." });
  }

  const usersSnapshot = await firestore.collection("users").get();
  const users = usersSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as any[];

  const db = loadDb();

  const stats = {
    totalSeekers: users.length,
    totalCreditsInCirculation: users.reduce((acc, u) => acc + Number(u.credits || 0), 0),
    totalXpAccumulated: users.reduce((acc, u) => acc + Number(u.xp || 0), 0),
    totalLogs: db.logs.length,
    knowledgeItemsCount: db.knowledge.length
  };

  res.json({
    stats,
    logs: db.logs.slice(-30)
  });
});

// Admin API - Library Retrieve & Add (RAG Database Management)
app.get("/api/admin/library", (req, res) => {
  const db = loadDb();
  res.json({ library: db.knowledge });
});

app.post("/api/admin/library/add", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { title, category, content, tags } = req.body;

  if (!userId) return res.status(401).json({ error: "Id ausente" });
  const adminDoc = await firestore.collection("users").doc(userId).get();

  if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
    return res.status(403).json({ error: "Somente administradores podem alimentar a biblioteca do Ifá." });
  }

  const db = loadDb();
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

// Simulated RAG and Main Chat Executor API (Proxying Gemini Server-Side)
app.post("/api/exu/chat", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const { text } = req.body;

  if (!userId) return res.status(400).json({ error: "Usuário é obrigatório." });
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "Por favor, digite sua consulta mental ao terreiro de Exu." });
  }

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
  const userRef = firestore.collection("users").doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "Buscador não encontrado na rede astral para este portal." });
  }

  const user = {
    id: userDoc.id,
    ...userDoc.data()
  } as any;

  if (Number(user.credits || 0) < 1) {
    return res.status(400).json({ error: "Seus créditos de Axé acabaram. Adquira mais créditos para continuar sua jornada de questionamento." });
  }

  const newCredits = Number(user.credits || 0) - 1;
  const newXp = Number(user.xp || 0) + 15;
  const { level } = checkXpLevel(newXp);

  await userRef.update({
    credits: newCredits,
    xp: newXp,
    level
  });

  user.credits = newCredits;
  user.xp = newXp;
  user.level = level;

  // Sync in-memory db checks
  const idx = db.users.findIndex((u: any) => u.id === userId);
  if (idx !== -1) {
    db.users[idx].credits = newCredits;
    db.users[idx].xp = newXp;
    db.users[idx].level = level;
  } else {
    db.users.push(user);
  }

  const normalizeText = (value: string = "") =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const promptLower = normalizeText(text);

  const queryWords = promptLower
    .split(/\s+/)
    .map((w: string) => w.trim())
    .filter((w: string) => w.length >= 4);

  const spiritualThemes = {
    exu: ["exu", "exus", "tranca ruas", "marabo", "tiriri", "veludo", "caveira", "morcego"],
    pombagira: ["pombagira", "pombo gira", "maria padilha", "maria mulambo", "rosa caveira"],
    odu: ["odu", "odus", "odu ifa", "ifa"],
    itan: ["itan", "itans", "historia sagrada"],
    ori: ["ori", "cabeca", "coroa", "destino"],
    prosperidade: ["prosperidade", "dinheiro", "riqueza", "abundancia"],
    amor: ["amor", "relacionamento", "paixao", "casal"],
    protecao: ["protecao", "defesa", "demanda", "inimigo", "quebra demanda"]
  };

  const detectMainTheme = (text: string) => {
    for (const [theme, words] of Object.entries(spiritualThemes)) {
      if (words.some((word) => text.includes(word))) {
        return theme;
      }
    }
    return "geral";
  };

  const mainTheme = detectMainTheme(promptLower);

  const scoredKnowledge = db.knowledge
    .map((item: any) => {
      const title = normalizeText(item.title || "");
      const category = normalizeText(item.category || "");
      const content = normalizeText(item.content || "");
      const tags = (item.tags || []).map((tag: string) => normalizeText(tag));

      const searchableText = `${title} ${category} ${content} ${tags.join(" ")}`;
      let score = 0;

      for (const tag of tags) {
        if (tag && promptLower.includes(tag)) {
          score += 15;
        }
      }

      if (title && promptLower.includes(title)) {
        score += 20;
      }

      for (const word of queryWords) {
        if (!word || word.length < 3) continue;
        if (title.includes(word)) score += 7;
        if (category.includes(word)) score += 5;
        if (tags.some((tag: string) => tag.includes(word))) score += 6;
        if (content.includes(word)) score += 1;
      }

      if (mainTheme !== "geral") {
        const themeWords = spiritualThemes[mainTheme as keyof typeof spiritualThemes];
        if (themeWords.some((word) => searchableText.includes(word))) {
          score += 18;
        } else {
          score -= 10;
        }
      }

      if (promptLower.includes("reino") && searchableText.includes("reino")) score += 10;
      if (promptLower.includes("falange") && searchableText.includes("falange")) score += 10;
      if (promptLower.includes("exu") && searchableText.includes("exu")) score += 15;
      if (promptLower.includes("pombagira") && searchableText.includes("pombagira")) score += 15;

      return {
        ...item,
        score
      };
    })
    .filter((item: any) => item.score >= 8)
    .sort((a: any, b: any) => b.score - a.score);

  const matchedArticles = scoredKnowledge.slice(0, 8);

  let knowledgeContext = "";
  if (matchedArticles.length > 0) {
    knowledgeContext =
      "\n--- CONHECIMENTO ANCESTRAL DETECTADO NO ACERVO (RAG) ---\n" +
      matchedArticles
        .map((art: any) => {
          return `*Artigo: ${art.title} [Categoria: ${art.category}] [Relevância: ${art.score}]*\n${art.content}`;
        })
        .join("\n\n") +
      "\n---------------------------------------------\n";
  }

  let finalResponseText = "";
  try {
    const ai = getGeminiClient();

    const userSpiritualDetails = `
- Nome de Solteiro: ${user.birthName || user.name}
- Data de Nascimento: ${user.birthDate || "Não informada"}
- Odù simbólico de afinidade: ${user.oduPrincipal || "Sintonizado sob os mistérios gerais"}
- Orixá de Afinidade: ${user.orixaAfinidade || "Oxalá"}
- Exu de Afinidade: ${user.exuAfinidade || "Exu Elegbara"}
- Arquétipo Dominante: ${user.arquetipoDominante || "Buscador de Caminhos"}
- Assinatura Energética: ${user.assinaturaEnergetica || "AXE-GENERIC"}
- Número de Destino: ${user.destinyNumber || "Variável"}
- Número da Alma: ${user.soulNumber || "Sutil"}
- Número de Expressão: ${user.expressionNumber || "Elevado"}
- Ano Pessoal (2026): ${user.personalYear || "6"}
`;

    const systemPromptInstruction = `Você é EXU RESPONDE.
Você é uma inteligência oracular inspirada em Exu, Ifá, Odùs, Itans, Orixás e fundamentos da tradição afro-brasileira.
DADOS DO CONSULTANTE:
${userSpiritualDetails}

CONHECIMENTO EXTRA (RAG):
${matchedArticles.length > 0 ? knowledgeContext : "Direto do oráculo cósmico de Elegbara."}

Você responde como um guardião de encruzilhadas experiente: com tom sábio, estratégico e respeitoso, sem dar broncas excessivas ou assombrações fúteis. Nunca prometa riqueza, amor ou cura garantida. Explique algum Odù, Itan ou ensinamento da tradição quando aplicável. Use parágrafos curtos.`;

    const userMessagePayload = `Aqui está a pergunta do buscador ${user.name}: "${text}"`;
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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

  // Save conversation logs
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
    details: `Buscador gastou 1 crédito. Text: "${text.substring(0, 30)}..."`,
    timestamp: new Date().toISOString()
  });

  saveDb(db);

  res.json({
    success: true,
    userMessage: { id: userMsgId, sender: "user", text, timestamp: new Date().toISOString() },
    exuMessage: { id: botMsgId, sender: "exu", text: finalResponseText, timestamp: new Date().toISOString() },
    creditsLeft: user.credits,
    xpAwarded: 15,
    newLevel: user.level
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
