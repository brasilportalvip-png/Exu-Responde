/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, Compass, Flame, Calendar, Award, BookOpen, Clock, Heart, DollarSign, Key, Info } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, TarotCard } from "../types";

interface OraculosProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
  openCreditsMenu: () => void;
}

type ActiveOracleTab = "tarot" | "numerology" | "astrology";

export default function Oraculos({ user, onUpdateUser, openCreditsMenu }: OraculosProps) {
  const [activeTab, setActiveTab] = useState<ActiveOracleTab>("tarot");

  // --- TAROT ORACLE STATE ---
  const [tarotOption, setTarotOption] = useState<1 | 3>(1);
  const [tarotQuestion, setTarotQuestion] = useState("");
  const [tarotLoading, setTarotLoading] = useState(false);
  const [tarotResult, setTarotResult] = useState<{
    drawn: any[];
    interpretation: string;
    xpAwarded: number;
  } | null>(null);
  const [flippedCards, setFlippedCards] = useState<number[]>([]);

  // --- NUMEROLOGY STATE ---
  const [numName, setNumName] = useState(user.birthName || user.name || "");
  const [numBirthDate, setNumBirthDate] = useState(user.birthDate || "");
  const [numLoading, setNumLoading] = useState(false);
  const [numResult, setNumResult] = useState<any | null>(null);

  // --- ASTROLOGY STATE ---
  const [astrologyBirthDate, setAstrologyBirthDate] = useState(user.birthDate || "");
  const [astrologyLoading, setAstrologyLoading] = useState(false);
  const [astrologyResult, setAstrologyResult] = useState<any | null>(null);
  const [astrologyError, setAstrologyError] = useState("");

  // --- TAROT DRAW TRIGGER ---
  const drawTarotCards = async () => {
    if (user.credits < (tarotOption === 3 ? 3 : 2)) {
      AudioEngine.playPortalSwoosh();
      openCreditsMenu();
      return;
    }

    setTarotLoading(true);
    setTarotResult(null);
    setFlippedCards([]);
    AudioEngine.playPortalSwoosh();

    try {
      const res = await fetch("/api/oraculo/tarot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id
        },
        body: JSON.stringify({
          question: tarotQuestion,
          slotsCount: tarotOption
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Erro ao consultar o tarô dos caminhos.");
      }

      setTarotResult({
        drawn: data.drawn,
        interpretation: data.interpretation,
        xpAwarded: data.xpAwarded
      });

      onUpdateUser({
        ...user,
        credits: data.creditsLeft,
        xp: user.xp + data.xpAwarded,
        level: data.newLevel
      });

      // Staggered card flip animation trigger helper
      data.drawn.forEach((_: any, idx: number) => {
        setTimeout(() => {
          setFlippedCards(prev => [...prev, idx]);
          AudioEngine.playCrystalBell();
        }, (idx + 1) * 800);
      });

    } catch (err: any) {
      alert(err.message || "Tentativa falhou.");
    } finally {
      setTarotLoading(false);
    }
  };

  // --- NUMEROLOGY TRIGGER ---
  const calculateNumerologyReport = async () => {
    if (!numBirthDate) {
      alert("Por favor, preencha sua data de nascimento.");
      return;
    }
    if (user.credits < 2) {
      openCreditsMenu();
      return;
    }

    setNumLoading(true);
    setNumResult(null);
    AudioEngine.playPortalSwoosh();

    try {
      const res = await fetch("/api/oraculo/numerologia", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id
        },
        body: JSON.stringify({
          birthName: numName,
          birthDate: numBirthDate
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Erro cosmético de simetria nos cálculos.");
      }

      setNumResult(data.details);
      AudioEngine.playCrystalBell();

      onUpdateUser({
        ...user,
        credits: data.creditsLeft,
        xp: user.xp + 25,
        level: data.newLevel,
        birthDate: numBirthDate,
        birthName: numName
      });

    } catch (err: any) {
      alert(err.message || "Erro de oráculo.");
    } finally {
      setNumLoading(false);
    }
  };

  // --- ASTROLOGY CALCULATE LOCAL ---
  const triggerAstrologyLocal = () => {
    const targetDate = astrologyBirthDate || user.birthDate;
    if (!targetDate) {
      setAstrologyError("Por favor, selecione sua data de nascimento.");
      return;
    }
    setAstrologyError("");
    setAstrologyLoading(true);
    AudioEngine.playCrystalBell();

    setTimeout(() => {
      // Decode birthday sign and spiritual element
      const dateParts = targetDate.split("-");
      if (dateParts.length < 3) {
        setAstrologyLoading(false);
        return;
      }
      const month = parseInt(dateParts[1]);
      const day = parseInt(dateParts[2]);

      let sunSign = "Áries";
      let element: "Fogo" | "Terra" | "Ar" | "Água" = "Fogo";
      let rulingPlanet = "Marte";
      let dominantHouse = 1;
      let compatibility = "Sagitário, Leão, Libra";
      let advice = "";

      if ((month == 3 && day >= 21) || (month == 4 && day <= 19)) {
        sunSign = "Áries"; element = "Fogo"; rulingPlanet = "Marte"; dominantHouse = 1;
        advice = "Sua determinação está fervilhando. Exu pede prudência com as palavras e rapidez na execução de planos.";
      } else if ((month == 4 && day >= 20) || (month == 5 && day <= 20)) {
        sunSign = "Touro"; element = "Terra"; rulingPlanet = "Vênus"; dominantHouse = 2; compatibility = "Virgem, Capricórnio, Peixes";
        advice = "A estabilidade e o plantio de sementes produtivas estão operando. Evite a preguiça espiritual; mova sua matéria.";
      } else if ((month == 5 && day >= 21) || (month == 6 && day <= 20)) {
        sunSign = "Gêmeos"; element = "Ar"; rulingPlanet = "Mercúrio"; dominantHouse = 3; compatibility = "Libra, Aquário, Áries";
        advice = "As correntes do conhecimento ancestral guiam você. Ótimo ciclo para estudos profundos. Cuidado com dispersão.";
      } else if ((month == 6 && day >= 21) || (month == 7 && day <= 22)) {
        sunSign = "Câncer"; element = "Água"; rulingPlanet = "Lua"; dominantHouse = 4; compatibility = "Escorpião, Peixes, Touro";
        advice = "A maré da intuição mística está elevadíssima. Ouça mais o seu coração e as preces silenciosas de proteção.";
      } else if ((month == 7 && day >= 23) || (month == 8 && day <= 22)) {
        sunSign = "Leão"; element = "Fogo"; rulingPlanet = "Sol"; dominantHouse = 5; compatibility = "Áries, Sagitário, Gêmeos";
        advice = "O brilho do axé solar e sua energia de realeza dominam. Use essa autoridade para erguer os outros, livre de soberba.";
      } else if ((month == 8 && day >= 23) || (month == 9 && day <= 22)) {
        sunSign = "Virgem"; element = "Terra"; rulingPlanet = "Mercúrio"; dominantHouse = 6; compatibility = "Touro, Capricórnio, Câncer";
        advice = "Organização sutil ajuda a moldar seus propósitos. Orixá Oxóssi indica caminhos prósperos nas decisões de longo prazo.";
      } else if ((month == 9 && day >= 23) || (month == 10 && day <= 22)) {
        sunSign = "Libra"; element = "Ar"; rulingPlanet = "Vênus"; dominantHouse = 7; compatibility = "Gêmeos, Aquário, Sagitário";
        advice = "A balança da justiça cósmica ressoa em sua encruzilhada afetiva. Escolha o equilíbrio e rejeite dependências.";
      } else if ((month == 10 && day >= 23) || (month == 11 && day <= 21)) {
        sunSign = "Escorpião"; element = "Água"; rulingPlanet = "Plutão"; dominantHouse = 8; compatibility = "Câncer, Peixes, Virgem";
        advice = "Poderosas forças de transmutação íntima estão agindo. Deixe morrer o que já feneceu para que o novo caminho nasça.";
      } else if ((month == 11 && day >= 22) || (month == 12 && day <= 21)) {
        sunSign = "Sagitário"; element = "Fogo"; rulingPlanet = "Júpiter"; dominantHouse = 9; compatibility = "Áries, Leão, Aquário";
        advice = "Foco certeiro do caçador de caminhos. A busca por horizontes sagrados será vitoriosa sob a égide do conhecimento.";
      } else if ((month == 12 && day >= 22) || (month == 1 && day <= 19)) {
        sunSign = "Capricórnio"; element = "Terra"; rulingPlanet = "Saturno"; dominantHouse = 10; compatibility = "Touro, Virgem, Escorpião";
        advice = "Sua escalada mística exige perseverança e bases morais limpas. Desfrute da solidez sem pressa ou angústia material.";
      } else if ((month == 1 && day >= 20) || (month == 2 && day <= 18)) {
        sunSign = "Aquário"; element = "Ar"; rulingPlanet = "Urano"; dominantHouse = 11; compatibility = "Gêmeos, Libra, Sagitário";
        advice = "Inovação, quebra de paradigmas pesados. O oráculo sugere que seus ideais humanitários estão alinhados com o progresso.";
      } else {
        sunSign = "Peixes"; element = "Água"; rulingPlanet = "Netuno"; dominantHouse = 12; compatibility = "Câncer, Escorpião, Touro";
        advice = "Os oceanos de Iemanjá trazem clareza silenciosa. Cuide de seu campo áurico e evite poços de melancolia passageira.";
      }

      setAstrologyResult({
        sunSign, element, rulingPlanet, dominantHouse, compatibility, advice,
        analysis: `O elemento reitor de sua coroa astral é ${element}. Isto dita que sua personalidade atua em sintonia com os ventos do planeta ${rulingPlanet}, influenciando o desenvolvimento de forças de conquista na Casa Astrológica ${dominantHouse}. Exu acompanha seus passos nesse quadrante sideral.`
      });
      setAstrologyLoading(false);
    }, 1200);
  };

  return (
    <div id="oraculos_container" className="grid grid-cols-1 lg:grid-cols-4 gap-6 font-sans">
      
      {/* Sidebar Selector Navigation Column */}
      <div className="lg:col-span-1 flex flex-col gap-2.5">
        <div className="bg-zinc-950/70 border border-red-950/40 p-4 rounded-2xl flex flex-col gap-2 select-none backdrop-blur-md">
          <span className="text-[9px] font-mono font-bold text-zinc-500 tracking-widest uppercase mb-1">Escolha o Oráculo Superior</span>
          
          <button
            id="tab_tarot"
            onClick={() => setActiveTab("tarot")}
            className={`w-full text-left px-4 py-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              activeTab === "tarot"
                ? "bg-red-950/40 border-yellow-500/40 text-yellow-400 shadow-[0_4px_15px_rgba(234,179,8,0.1)]"
                : "bg-black/40 border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <span className="text-sm">🃏</span>
            <div className="text-xs">
              <p className="font-bold tracking-wider">TARÔ DOS CAMINHOS</p>
              <span className="text-[10px] text-zinc-500 font-mono">1 ou 3 Cartas • Consome Axé</span>
            </div>
          </button>

          <button
            id="tab_numerology"
            onClick={() => setActiveTab("numerology")}
            className={`w-full text-left px-4 py-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              activeTab === "numerology"
                ? "bg-red-950/40 border-yellow-500/40 text-yellow-400 shadow-[0_4px_15px_rgba(234,179,8,0.1)]"
                : "bg-black/40 border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <span className="text-sm">✨</span>
            <div className="text-xs">
              <p className="font-bold tracking-wider">MAPA NUMEROLÓGICO</p>
              <span className="text-[10px] text-zinc-500 font-mono">Cabalístico Ifá • Consome Axé</span>
            </div>
          </button>

          <button
            id="tab_astrology"
            onClick={() => setActiveTab("astrology")}
            className={`w-full text-left px-4 py-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              activeTab === "astrology"
                ? "bg-red-950/40 border-yellow-500/40 text-yellow-400 shadow-[0_4px_15px_rgba(234,179,8,0.1)]"
                : "bg-black/40 border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <span className="text-sm">🪐</span>
            <div className="text-xs">
              <p className="font-bold tracking-wider">ASTROLOGIA ANCESTRAL</p>
              <span className="text-[10px] text-zinc-500 font-mono">Signo & Elemento • Gratuito</span>
            </div>
          </button>
        </div>

        {/* Dynamic Tips Alert box */}
        <div className="bg-red-950/25 border border-red-900/30 p-4 rounded-2xl">
          <div className="flex gap-2 items-start text-xs text-zinc-400 leading-relaxed">
            <Info className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-mono font-bold text-yellow-500/90 mb-1 uppercase text-[10px]">REGRAS DOS PORTAIS</p>
              <p>O Tarô e a Numerologia se fundamentam na sua identidade natal espiritual. Sempre preencha seu perfil para obter máxima calibração.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main interactive area Column */}
      <div className="lg:col-span-3">
        <AnimatePresence mode="wait">
          
          {/* TAB 1: TAROT DOS CAMINHOS */}
          {activeTab === "tarot" && (
            <motion.div
              key="oracle_tarot"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="bg-zinc-950/80 border border-red-950/40 p-6 sm:p-8 rounded-3xl backdrop-blur-md space-y-6"
            >
              <div className="flex items-center justify-between border-b border-red-950/50 pb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-widest text-yellow-400 uppercase">Tarô Sagrado das Encruzilhadas</h2>
                  <p className="text-xs text-zinc-500">Formule sua pergunta com mentalidade focada e receba a revelação guiada por Exu</p>
                </div>
                <span className="text-2xl">🃏</span>
              </div>

              {/* Form Input config */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="tarot_focus_input" className="block text-xs font-mono text-zinc-400 uppercase font-semibold">Qual a tormenta de sua mente no momento?</label>
                  <input
                    id="tarot_focus_input"
                    type="text"
                    value={tarotQuestion}
                    onChange={(e) => setTarotQuestion(e.target.value)}
                    placeholder="Ex: Vida financeira próspera, união afetiva, proteção..."
                    className="w-full px-4 py-3 rounded-xl border border-red-950 bg-black text-amber-100 placeholder-zinc-700 text-sm focus:outline-none focus:border-yellow-500/60 transition-all"
                  />
                </div>
                
                <div className="space-y-2">
                  <label className="block text-xs font-mono text-zinc-400 uppercase font-semibold">Profundidade da Leitura Sideral</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setTarotOption(1)}
                      className={`py-3 px-2 rounded-xl border text-[10.5px] sm:text-xs font-mono font-bold tracking-wider cursor-pointer transition-all ${
                        tarotOption === 1
                          ? "bg-red-950/40 border-yellow-500/50 text-yellow-400"
                          : "bg-black border-red-950/50 text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      1 CARTA (Conselho Rápido • 2 Axé)
                    </button>
                    <button
                      type="button"
                      onClick={() => setTarotOption(3)}
                      className={`py-3 px-2 rounded-xl border text-[10.5px] sm:text-xs font-mono font-bold tracking-wider cursor-pointer transition-all ${
                        tarotOption === 3
                          ? "bg-red-950/40 border-yellow-500/50 text-yellow-400"
                          : "bg-black border-red-950/50 text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      3 CARTAS (Passado/Pres/Fut • 3 Axé)
                    </button>
                  </div>
                </div>
              </div>

              {/* Draw Oraculic action triggers */}
              <div className="flex flex-col items-center">
                <button
                  id="draw_tarot_action"
                  onClick={drawTarotCards}
                  disabled={tarotLoading}
                  className="px-8 py-3.5 bg-gradient-to-r from-yellow-400 to-amber-600 hover:from-yellow-300 hover:to-amber-500 font-bold tracking-widest text-black text-xs rounded-xl shadow-[0_4px_20px_rgba(234,179,8,0.2)] hover:shadow-yellow-500/30 active:scale-95 transition-all cursor-pointer disabled:opacity-50 uppercase flex items-center gap-2"
                >
                  {tarotLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      <span>CRUZANDO PORTAIS DO TEMPO...</span>
                    </>
                  ) : (
                    <>
                      <Compass className="w-4 h-4 animate-spin" style={{ animationDuration: "10s" }} />
                      <span>REVELAR ORÁCULO DE EXU DECK</span>
                    </>
                  )}
                </button>
              </div>

              {/* Graphic cards flip section */}
              {tarotResult && (
                <div className="space-y-6 pt-4 border-t border-red-950/30">
                  <div className="flex flex-wrap justify-center gap-6 py-6 select-none">
                    {tarotResult.drawn.map((card, idx) => {
                      const isFlipped = flippedCards.includes(idx);
                      
                      return (
                        <div key={idx} className="w-36 h-56 [perspective:1000px] flex flex-col items-center">
                          <span className="text-[10px] font-mono text-zinc-500 tracking-widest mb-1.5 uppercase">
                            {tarotOption === 3 ? (idx === 0 ? "Passado" : idx === 1 ? "Presente" : "Futuro") : "Direcionamento"}
                          </span>

                          <div className={`relative w-full h-full transition-all duration-[800ms] [transform-style:preserve-3d] ${isFlipped ? '[transform:rotateY(180deg)]' : ''}`}>
                            
                            {/* FRONT Side (Card back texture) */}
                            <div className="absolute inset-0 bg-zinc-950 border-2 border-yellow-500/50 rounded-xl p-2 flex flex-col justify-between items-center [backface-visibility:hidden] shadow-lg">
                              <div className="w-full text-left text-[8px] text-yellow-600 tracking-widest font-mono">EXE</div>
                              <div className="w-14 h-14 rounded-full border border-red-900/60 flex items-center justify-center p-1 bg-black animate-pulse">
                                <span className="text-xl">🔱</span>
                              </div>
                              <div className="w-full text-right text-[8px] text-yellow-600 tracking-widest font-mono">LAROYE</div>
                            </div>

                            {/* REVERSE Side (Flipped Card Value) */}
                            <div className="absolute inset-x-0 inset-y-0 bg-gradient-to-t from-red-950/40 via-zinc-900 to-black border-2 border-yellow-400 rounded-xl [transform:rotateY(180deg)] [backface-visibility:hidden] p-3 flex flex-col justify-between items-center shadow-xl">
                              <span className="text-yellow-400 font-mono text-xs font-bold uppercase">{card.reversed ? "⚠️ INVERTIDA" : "✦ NORMAL"}</span>
                              <div className="text-4xl filter drop-shadow-[0_2px_10px_rgba(234,179,8,0.3)]">{card.symbol}</div>
                              <div className="text-center">
                                <h4 className="text-amber-100 font-bold text-xs tracking-wider line-clamp-1">{card.name}</h4>
                                <span className="text-[9px] font-mono text-zinc-500">{card.arcana} arcano</span>
                              </div>
                            </div>

                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Gemini Interpretation Text box */}
                  <div className="bg-black/60 border border-red-950/40 p-5 rounded-2xl hover:border-yellow-500/20 transition-all select-text">
                    <p className="text-[10px] font-mono tracking-widest text-yellow-500 uppercase font-bold mb-2">CONSELHO E REVELAÇÃO DO ORÁCULO DE EXU:</p>
                    <div className="text-sm text-zinc-300 leading-relaxed space-y-3 whitespace-pre-wrap selection:bg-red-900 select-text">
                      {tarotResult.interpretation}
                    </div>
                  </div>
                </div>
              )}

            </motion.div>
          )}

          {/* TAB 2: MAPA NUMEROLÓGICO */}
          {activeTab === "numerology" && (
            <motion.div
              key="oracle_numerology"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="bg-zinc-950/80 border border-red-950/40 p-6 sm:p-8 rounded-3xl backdrop-blur-md space-y-6"
            >
              <div className="flex items-center justify-between border-b border-red-950/50 pb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-widest text-yellow-400 uppercase">Mapa Numerológico Cabalístico Ifá</h2>
                  <p className="text-xs text-zinc-500">Descubra as forças ocultas dos números sob a data natalicia e o nome de registro</p>
                </div>
                <span className="text-2xl font-mono text-yellow-500">✨</span>
              </div>

              {/* Form Input fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="num_name_input" className="block text-xs font-mono text-zinc-400 uppercase font-semibold">Nome de Nascimento de Registro</label>
                  <input
                    id="num_name_input"
                    type="text"
                    value={numName}
                    onChange={(e) => setNumName(e.target.value)}
                    placeholder="Nome completo para calibração cabalística"
                    className="w-full px-4 py-3 rounded-xl border border-red-950 bg-black text-amber-100 placeholder-zinc-700 text-sm focus:outline-none focus:border-yellow-500/60 transition-all"
                  />
                </div>
                
                <div className="space-y-2">
                  <label htmlFor="num_date_input" className="block text-xs font-mono text-zinc-400 uppercase font-semibold">Data Natalícia Sideral</label>
                  <input
                    id="num_date_input"
                    type="date"
                    value={numBirthDate}
                    onChange={(e) => setNumBirthDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-red-950 bg-black text-amber-100 placeholder-zinc-700 text-sm focus:outline-none focus:border-yellow-500/60 transition-all font-mono"
                  />
                </div>
              </div>

              {/* Submit calculations button */}
              <div className="flex justify-center">
                <button
                  id="calc_numerology_action"
                  onClick={calculateNumerologyReport}
                  disabled={numLoading}
                  className="px-8 py-3.5 bg-gradient-to-r from-yellow-400 to-amber-600 hover:from-yellow-300 hover:to-amber-500 font-bold tracking-widest text-black text-xs rounded-xl shadow-[0_4px_20px_rgba(234,179,8,0.15)] hover:shadow-yellow-500/35 transition-all cursor-pointer disabled:opacity-50 uppercase flex items-center gap-2"
                >
                  {numLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      <span>EFETUANDO EQUAÇÕES DE IFÁ...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-black" />
                      <span>GERAR MAPA CABALÍSTICO (2 Axé)</span>
                    </>
                  )}
                </button>
              </div>

              {/* Numerology detailed report result */}
              {numResult && (
                <div className="space-y-6 pt-4 border-t border-red-950/30 animate-fade-in">
                  
                  {/* Grid showing computed numbers */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-2">
                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Caminho do Destino</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.destinyNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">Rota e encruzilhadas</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Número de Alma</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.soulNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">Desejos internos</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Número de Expressão</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.expressionNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">Talentos latentes</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Ano Pessoal</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.personalYear}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">Ciclos para 2026</small>
                    </div>
                  </div>

                  {/* Interpretive text section */}
                  <div className="bg-black/60 border border-red-950/40 p-5 rounded-2xl select-text">
                    <p className="text-[10px] font-mono tracking-widest text-yellow-500 uppercase font-bold mb-2">ANÁLISE DE ENERGIA EXU RESPONDE:</p>
                    <div className="text-sm text-zinc-300 leading-relaxed space-y-3 whitespace-pre-wrap select-text selection:bg-red-900">
                      {numResult.analysis}
                    </div>
                  </div>

                </div>
              )}

            </motion.div>
          )}

          {/* TAB 3: ASTROLOGIA ANCESTRAL */}
          {activeTab === "astrology" && (
            <motion.div
              key="oracle_astrology"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="bg-zinc-950/80 border border-red-950/40 p-6 sm:p-8 rounded-3xl backdrop-blur-md space-y-6"
            >
              <div className="flex items-center justify-between border-b border-red-950/50 pb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-widest text-yellow-400 uppercase">Astrologia dos Orixás Ancestrais</h2>
                  <p className="text-xs text-zinc-500">Sincronize a órbita de sua vida com o seu elemento natural protetor - sem custo de Axé</p>
                </div>
                <span className="text-2xl font-mono text-yellow-500">🪐</span>
              </div>

              {/* Date natal Selection */}
              <div className="max-w-md mx-auto space-y-4">
                <div className="space-y-2">
                  <label htmlFor="astro_date_input" className="block text-center text-xs font-mono text-zinc-400 uppercase font-semibold">Sua Data de Nascimento</label>
                  <input
                    id="astro_date_input"
                    type="date"
                    value={astrologyBirthDate}
                    onChange={(e) => setAstrologyBirthDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-red-950 bg-black text-amber-100 placeholder-zinc-700 text-sm focus:outline-none focus:border-yellow-500/60 transition-all font-mono"
                  />
                </div>

                {astrologyError && <div className="text-xs text-red-500 text-center font-mono">⚠️ {astrologyError}</div>}

                <div className="flex justify-center">
                  <button
                    id="calc_astrology_action"
                    onClick={triggerAstrologyLocal}
                    disabled={astrologyLoading}
                    className="px-6 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-yellow-500/30 text-yellow-400 font-bold tracking-widest text-xs rounded-xl transition-all cursor-pointer"
                  >
                    {astrologyLoading ? "CALCULANDO ESTRELAS ACOPLADAS..." : "MAPEAR ELEMENTO CÓSMICO"}
                  </button>
                </div>
              </div>

              {/* Astrology detailed result display */}
              {astrologyResult && (
                <div className="space-y-6 pt-4 border-t border-red-950/30 animate-fade-in">
                  
                  {/* Grid elements */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-red-950/30 p-4 rounded-xl">
                      <span className="text-[9px] font-mono text-yellow-600 block uppercase font-bold">Signo Sideral</span>
                      <strong className="text-lg font-bold text-yellow-400 block mt-1.5">{astrologyResult.sunSign}</strong>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-red-950/30 p-4 rounded-xl">
                      <span className="text-[9px] font-mono text-yellow-600 block uppercase font-bold">Elemento Reitor</span>
                      <strong className="text-lg font-bold text-yellow-400 block mt-1.5">{astrologyResult.element}</strong>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-red-950/30 p-4 rounded-xl">
                      <span className="text-[9px] font-mono text-yellow-600 block uppercase font-bold">Planeta Regente</span>
                      <strong className="text-lg font-bold text-yellow-400 block mt-1.5">{astrologyResult.rulingPlanet}</strong>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-red-950/30 p-4 rounded-xl">
                      <span className="text-[9px] font-mono text-yellow-600 block uppercase font-bold">Sinastria Ideal</span>
                      <strong className="text-xs font-bold text-yellow-400 block mt-1.5 leading-tight">{astrologyResult.compatibility}</strong>
                    </div>
                  </div>

                  {/* Astrological analysis and direct Exu advice */}
                  <div className="bg-black/60 border border-red-950/40 p-5 rounded-2xl select-text">
                    <p className="text-[10px] font-mono tracking-widest text-yellow-500 uppercase font-bold mb-2">ANÁLISE DE CORRESPONDÊNCIA DOS ASTROS:</p>
                    <p className="text-sm text-zinc-300 leading-relaxed selection:bg-red-900 mb-4">{astrologyResult.analysis}</p>
                    
                    <div className="border-t border-zinc-800 pt-4 flex gap-3 items-start select-text leading-relaxed">
                      <span className="text-xl">🔱</span>
                      <div>
                        <strong className="text-xs font-mono text-yellow-500 block uppercase mb-1">ELEGBA ADVICE:</strong>
                        <p className="text-sm text-zinc-400">{astrologyResult.advice}</p>
                      </div>
                    </div>
                  </div>

                </div>
              )}

            </motion.div>
          )}

        </AnimatePresence>
      </div>

    </div>
  );
}
