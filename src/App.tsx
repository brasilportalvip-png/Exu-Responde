/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Sparkles, Compass, LogIn, LogOut, Flame, Volume2, VolumeX, Send, 
  BookOpen, User, Coins, Award, ShieldCheck, Terminal, HelpCircle, 
  RotateCcw, Trash2, Bookmark, Star, ChevronDown, CheckCircle
} from "lucide-react";
import { AudioEngine } from "./components/AudioEngine";
import { UserProfile, ChatMessage } from "./types";

// Import custom built components
import PortalEntrance from "./components/PortalEntrance";
import Oraculos from "./components/Oraculos";
import UserProfilePanel from "./components/UserProfile";
import PremiumCredits from "./components/PremiumCredits";
import AdminPanel from "./components/AdminPanel";

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
const [favorites, setFavorites] = useState<string[]>([]);
const [consultationType, setConsultationType] = useState<"comum" | "outros" | "completa">("comum");

const SESSION_KEY = "exu_responde_chat_session";
 
  // Modal controllers
  const [showEntranceModal, setShowEntranceModal] = useState(true);
  const [activeModal, setActiveModal] = useState<"profile" | "oracles" | "library" | "credits" | "admin" | null>(null);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [libraryTab, setLibraryTab] = useState<"odus" | "exus" | "arcades">("odus");

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load user session









  useEffect(() => {
  setUser(null);
  setMessages([]);
  setInputText("");
  setConsultationType("comum");
  setShowEntranceModal(true);
  setCheckedAuth(true);

  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("exu_user_id");
  localStorage.removeItem("exu_user_email");
}, []);










  // Set default initial greeting if chat is fresh
  const setDefaultGreeting = (currentUser: UserProfile) => {
    setMessages([
      {
        id: "exu_welcome",
        userId: currentUser.id,
        sender: "exu",
text: `Bem Vindo Ao Reino De Exu! Faça Sua Pergunta.`,
        timestamp: new Date().toISOString()
      }
    ]);
  };

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Handle continuous Sound toggling
  const toggleSound = () => {
    const nextState = !soundEnabled;
    setSoundEnabled(nextState);
    if (nextState) {
      AudioEngine.playDrone();
      AudioEngine.playCrystalBell();
    } else {
      AudioEngine.stopDrone();
    }
  };

  const handleLoginSuccess = (loggedInUser: UserProfile) => {
    setUser(loggedInUser);
    localStorage.setItem("exu_user_id", loggedInUser.id);
    localStorage.setItem("exu_user_email", loggedInUser.email);
    setShowEntranceModal(false);
    
    // Play transition sounds
    AudioEngine.playPortalSwoosh();
    if (soundEnabled) {
      AudioEngine.playDrone();
    }

    if (messages.length === 0) {
  setDefaultGreeting(loggedInUser);
}
  };

  const handleLogout = () => {
    AudioEngine.playPortalSwoosh();
    AudioEngine.stopDrone();
    setUser(null);
    setMessages([]);
    localStorage.removeItem("exu_user_id");
    localStorage.removeItem("exu_user_email");
localStorage.removeItem(SESSION_KEY);
    setActiveModal(null);
  };

  const syncUpdatedUser = (updatedUser: UserProfile) => {
    setUser(updatedUser);
  };

  // Chat message engine
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;

    // Direct registration check if user is blank
    if (!user) {
      setShowEntranceModal(true);
      return;
    }

    // Credits checking
    const requiredCredits = consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1);
    if (user.credits < requiredCredits) {
      AudioEngine.playPortalSwoosh();
      setActiveModal("credits");
      return;
    }

    const question = inputText;
    setInputText("");
    setLoading(true);
    AudioEngine.playCrystalBell();

    // Create user message locally
    const userMsg: ChatMessage = {
      id: "usr_" + Date.now(),
      userId: user.id,
      sender: "user",
      text: question,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMsg]);

    try {
      const res = await fetch("/api/exu/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id
        },
        body: JSON.stringify({ text: question, type: consultationType })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Ocorreu uma falha ao abrir a comunicação celestial.");
      }

      const xpAwarded = Number(data.xpAwarded || 0);
const creditCharged = Math.max(0, Number(user.credits || 0) - Number(data.creditsLeft || 0));

const exuMessageWithMeta: ChatMessage = {
  ...data.exuMessage,
  xpAwarded,
  creditCharged
};

// Add Exu reaction message
setMessages(prev => [...prev, exuMessageWithMeta]);

// Update client user
setUser({
  ...user,
  credits: data.creditsLeft,
  xp: user.xp + xpAwarded,
  level: data.newLevel
});

    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: "err_" + Date.now(),
          userId: user.id,
          sender: "exu",
          text: `⚠️ Alerta: ${err.message || 'Houve uma oscilação na ponte mística de comunicação. Seus créditos de Axé foram preservados.'}`,
          timestamp: new Date().toISOString()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const vocalizeMessage = (text: string) => {
    AudioEngine.playPortalSwoosh();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const cleanText = text.replace(/[*#🔱🔥]/g, "");
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = "pt-BR";
      utterance.rate = 0.95;
      utterance.pitch = 0.8; // Deep authoritative tone representing destiny
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleFavorite = (id: string) => {
    if (favorites.includes(id)) {
      setFavorites(prev => prev.filter(f => f !== id));
    } else {
      setFavorites(prev => [...prev, id]);
      AudioEngine.playCrystalBell();
    }
  };

  if (!checkedAuth) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center font-sans select-none">
        <div className="relative flex flex-col items-center">
          <div className="w-14 h-14 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-yellow-500/80 font-mono text-xs uppercase tracking-[0.25em] mt-5 animate-pulse">
            Invocando Caminhos Ocultos...
          </span>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen lg:h-screen bg-black text-white relative overflow-y-auto lg:overflow-hidden font-sans select-none flex flex-col">

      {/* ========================================== */}
      {/* INDEPENDENT DE INSTALLED PORTAL EMBELLISHMENTS */}
      {/* ========================================== */}
      <style>{`
        @keyframes floatUpParticle {
          0% { transform: translateY(105vh) scale(0.6) rotate(0deg); opacity: 0; }
          20% { opacity: 0.8; }
          80% { opacity: 0.6; }
          100% { transform: translateY(-10vh) scale(1.3) rotate(360deg); opacity: 0; }
        }
        .energy-ember {
          position: absolute;
          background: radial-gradient(circle, #f59e0b 0%, #dc2626 50%, rgba(0,0,0,0) 100%);
          border-radius: 50%;
          pointer-events: none;
          animation: floatUpParticle linear infinite;
        }
        /* Custom horizontal grid masks */
        .mystic-ray {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: linear-gradient(to bottom, transparent, rgba(239, 68, 68, 0.4), transparent);
          box-shadow: 0 0 15px rgba(239, 68, 68, 0.6);
          pointer-events: none;
        }
        /* Custom styled scrolls */
        .scrolling-pane::-webkit-scrollbar {
          width: 5px;
        }
        .scrolling-pane::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.3);
        }
        .scrolling-pane::-webkit-scrollbar-thumb {
          background: rgba(185, 28, 28, 0.4);
          border-radius: 9px;
        }



      `}</style>

     {/* FUNDO DA VINHETA */}
<div
  id="portal_espiritual"
  className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
>
  <video
    id="vinhete_video"
    src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/Exu-Responde.mp4"
    className="w-full h-full object-cover"
    autoPlay
    loop
    muted
    playsInline
    referrerPolicy="no-referrer"
  />
</div>

{/* PARTICULAS ENERGETICAS */}
<div id="particulas_energeticas" className="absolute inset-0 z-1 pointer-events-none overflow-hidden select-none">
  {Array.from({ length: 18 }).map((_, i) => {
    const randWidth = 4 + Math.random() * 8;
    const randLeft = Math.random() * 100;
    const randDuration = 10 + Math.random() * 15;
    const randDelay = Math.random() * 12;
    return (
      <div
        key={i}
        className="energy-ember"
        style={{
          width: `${randWidth}px`,
          height: `${randWidth}px`,
          left: `${randLeft}%`,
          animationDuration: `${randDuration}s`,
          animationDelay: `-${randDelay}s`,
        }}
      />
    );
  })}
</div>

      {/* NEVOA MISTICA */}
      <div id="nevoa_mistica" className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black via-black/85 to-transparent pointer-events-none z-2 select-none" />
      <div className="absolute -bottom-10 left-10 w-96 h-96 bg-red-950/20 rounded-full blur-[120px] pointer-events-none z-1 animate-pulse" />
      <div className="absolute -bottom-10 right-10 w-96 h-96 bg-orange-950/15 rounded-full blur-[130px] pointer-events-none z-1 animate-pulse" style={{ animationDuration: "9000ms" }} />

      {/* RAIOS VERMELHOS  */}
      <div id="raios_vermelhos_left" className="mystic-ray left-[2%] opacity-45 sm:opacity-85 z-1" />
      <div id="raios_vermelhos_right" className="mystic-ray right-[2%] opacity-45 sm:opacity-85 z-1" />


      {/* ========================================== */}
      {/* TOPO                                       */}
      {/* ========================================== */}
      <header className="absolute top-0 left-0 right-0 z-40 flex justify-between items-center p-3 sm:p-5 md:p-7 select-none">

        {/* LOGO EXU RESPONDE */}
        <div 
          className="flex items-center gap-2 sm:gap-3 cursor-pointer group"
          onClick={() => {
            AudioEngine.playCrystalBell();
            if (user) {
              setDefaultGreeting(user);
            }
          }}
        >
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-black/60 border border-yellow-500/30 flex items-center justify-center shadow-[0_0_15px_rgba(245,158,11,0.25)] group-hover:border-yellow-400 group-hover:shadow-[0_0_20px_rgba(245,158,11,0.4)] transition-all">
            <span className="text-sm sm:text-xl animate-pulse text-yellow-500">🔱</span>
          </div>
          <div className="flex flex-col text-left">
            <span className="text-xs sm:text-base md:text-lg font-black tracking-[0.1em] sm:tracking-[0.25em] text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 uppercase">
              EXU RESPONDE
            </span>
            <span className="hidden xs:block text-[7.5px] sm:text-[8.5px] font-mono text-zinc-500 uppercase tracking-widest leading-none font-bold">
              Sabedoria Ancestral & Caminhos
            </span>
          </div>
        </div>

        {/* BOTAO LOGIN / USER PROFILE HUB */}
        <div className="flex items-center gap-2 sm:gap-4.5">
          {user && (
            <>
              {/* Wallet indicator */}
              <button
                type="button"
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setActiveModal("credits");
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-red-650/10 to-amber-700/15 border border-yellow-500/25 text-yellow-400 font-bold hover:border-yellow-400 transition cursor-pointer shadow-[0_0_8px_rgba(234,179,8,0.1)]"
              >
                <Coins className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '10s' }} />
                <span className="text-xs font-mono font-black">{user.credits} <span className="text-[10px] text-amber-500">AXÉ</span></span>
              </button>
            </>
          )}

          {/* BOTÃO LOGIN/ENTRAR CONTROL */}
          {!user ? (
            <button
              id="botao_login_logged_out"
              onClick={() => {
                AudioEngine.playCrystalBell();
                setShowEntranceModal(true);
              }}
              className="px-5 py-2 rounded-full border border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500 hover:text-black text-yellow-500 text-xs font-bold font-mono tracking-widest transition-all duration-300 shadow-[0_0_15px_rgba(234,179,8,0.2)] cursor-pointer"
            >
              INICIAR ATENDIMENTO ⚜️
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                id="botao_profile_logged_in"
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setActiveModal("profile");
                }}
                className="flex items-center gap-2 px-3 py-1 rounded-full border border-zinc-800 bg-zinc-950/80 hover:border-yellow-500/30 transition-all cursor-pointer text-left"
              >
                <div className="w-6.5 h-6.5 rounded-full bg-yellow-600/10 border border-yellow-500/30 flex items-center justify-center text-xs">
                  👑
                </div>
                <div className="hidden md:block leading-none pr-1">
                  <div className="text-[10px] font-bold text-yellow-400 uppercase truncate max-w-[85px]">
                    {user.name}
                  </div>
                  <div className="text-[7.5px] font-mono text-zinc-500 uppercase tracking-widest font-black">
                    {user.level}
                  </div>
                </div>
              </button>

              <button
                onClick={handleLogout}
                title="Desconectar do Templo"
                className="p-2 rounded-full hover:bg-zinc-900/80 text-zinc-500 hover:text-red-500 transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

      </header>


      {/* ========================================== */}
      {/* ÁREA PRINCIPAL                             */}
      {/* ========================================== */}


      <section className="flex-1 lg:h-full flex flex-col items-center justify-center relative z-20 px-4 sm:px-6 pt-24 pb-8 lg:py-16 max-w-7xl mx-auto w-full transition-all">

{/* AVATAR EXU CINEMATOGRAFICO */}
        <div id="avatar_exu_cinematografico" className="relative shrink-0 flex items-center justify-center select-none w-[180px] h-[180px] sm:w-[240px] sm:h-[240px] lg:w-[300px] lg:h-[300px] my-1.5 sm:my-3 lg:my-0 transition-all origin-center">
          
          {/* External decorative spinning map rings */}
          <div className="absolute w-[205px] h-[205px] sm:w-[270px] sm:h-[270px] lg:w-[340px] lg:h-[340px] rounded-full border border-yellow-500/15 animate-spin duration-[24s]" />
          <div className="absolute w-[220px] h-[220px] sm:w-[290px] sm:h-[290px] lg:w-[370px] lg:h-[370px] rounded-full border border-dashed border-red-500/10 animate-reverse duration-[30s]" />
          
          {/* Thinking glow aura */}
          <div className={`absolute w-[190px] h-[190px] sm:w-[255px] sm:h-[255px] lg:w-[320px] lg:h-[320px] rounded-full bg-gradient-to-tr from-red-650 to-yellow-500 filter blur-2xl lg:blur-3xl transition-all duration-700 ${
            loading ? "opacity-40 scale-110" : "opacity-15 scale-95"
          }`} />

          {/* Core high-end video frame */}
          <div className={`relative w-[180px] h-[180px] sm:w-[240px] sm:h-[240px] lg:w-[300px] lg:h-[300px] rounded-full p-[3px] lg:p-[4px] bg-gradient-to-b from-yellow-300 via-amber-500 to-yellow-600 shadow-[0_0_35px_rgba(245,158,11,0.35)] lg:shadow-[0_0_55px_rgba(245,158,11,0.45)] transition-all duration-500 ${
            loading ? "scale-95 shadow-[0_0_75px_rgba(220,38,38,0.6)] bg-gradient-to-b from-red-500 to-amber-600" : "hover:scale-105"
          }`}>
            <div className="w-full h-full rounded-full overflow-hidden bg-zinc-950 border border-black relative">
 <img
  src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/ChatGPT-Image-29-de-mai.-de-2026-09_27_07.png"
  alt="Exu Responde"
  className="absolute inset-0 w-full h-full object-cover"
  referrerPolicy="no-referrer"
/>


             
<video
  src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/Exu-Responde.mp4"
  className="relative z-10 w-full h-full object-cover filter brightness-[0.7] contrast-[1.15]"
  autoPlay
  loop
  muted
  playsInline
  preload="auto"
  controls={false}
  disablePictureInPicture
  referrerPolicy="no-referrer"
/>


              {/* Volumetric red smoke flare overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-red-950/40 via-transparent to-transparent pointer-events-none" />
              
              {/* Interactive Oracle computing ring indicator */}
              {loading && (
                <div className="absolute inset-0 border-2 border-red-500 rounded-full animate-ping" />
              )}
            </div>
          </div>

          {/* Floating trident icon emblem tag */}
          <div className="absolute right-1 bottom-1 sm:right-2 sm:bottom-2 lg:right-4 lg:bottom-4 w-7 h-7 sm:w-9 sm:h-9 lg:w-11 lg:h-11 rounded-full bg-black border border-red-500/50 flex items-center justify-center shadow-2xl z-10 transition-all group-hover:scale-110">
            <span className="text-sm sm:text-base text-yellow-500">🔱</span>
          </div>
        </div>

        {/* FRASE INICIAL */}
        <h1 className="mt-5 text-2xl sm:text-4xl font-extrabold tracking-[0.15em] text-transparent bg-clip-text bg-gradient-to-b from-zinc-50 to-zinc-400 capitalize drop-shadow-md text-center max-w-lg">
          Salve sua banda, filho de fé.
        </h1>

        <p className="mt-2 text-center text-xs sm:text-sm max-w-xl text-zinc-400 tracking-wide font-medium leading-relaxed">
          Em que posso ajudar?
        </p>

        {/* CHAT ESTILO GPT */}
        

<div className="w-full max-w-3xl mt-4 sm:mt-6 flex flex-col h-[calc(100vh-320px)] min-h-[350px] sm:h-[480px] lg:h-[48vh] bg-zinc-950/40 border border-zinc-900/60 rounded-3xl p-3 sm:p-4 shadow-[0_20px_50px_rgba(0,0,0,0.92)] backdrop-blur-md relative z-10">

          <div id="chat_container" className="flex-1 overflow-y-auto pr-1 space-y-4 scrolling-pane select-text">
            
            {/* Standard Welcome layout fallback or Message Logs */}
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center h-full text-zinc-500">
                <p className="text-xs uppercase tracking-widest font-mono">Nenhuma consulta iniciada nesta encruzilhada.</p>
                <p className="text-[11px] font-mono text-zinc-600 mt-2">Sua jornada de conselho espiritual começa quando escrever abaixo.</p>
              </div>
            ) : (
              messages.map((msg) => {
                const isExu = msg.sender === "exu";
                const isFav = favorites.includes(msg.id);

                return (
                  <div
                    key={msg.id}
                    className={`flex gap-3 max-w-full sm:max-w-[90%] pb-1 ${isExu ? "mr-auto text-left" : "ml-auto flex-row-reverse text-right"}`}
                  >
                    {/* Small avatar circle */}
                    <div className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 overflow-hidden font-mono text-xs select-none ${
                      isExu ? "bg-black border-red-900 text-yellow-500" : "bg-red-950/20 border-red-500/10 text-red-400"
                    }`}>
                      {isExu ? (
                        <img 
                          src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/ChatGPT-Image-29-de-mai.-de-2026-09_27_07.png" 
                          alt="Exu Responde" 
                          className="w-full h-full object-cover" 
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        "🕊️"
                      )}
                    </div>

                    {/* Chat Bubble card */}
                    <div className={`p-3.5 sm:p-4 rounded-2xl md:text-[13px] text-xs leading-relaxed font-sans relative group select-text transition-all ${
                      isExu 
                        ? "bg-zinc-900/60 border border-zinc-800/80 text-amber-50 rounded-tl-none shadow-md" 
                        : "bg-red-950/15 border border-red-950/10 text-amber-100 rounded-tr-none"
                    }`}>
                      {/* Action buttons drawer inside bot bubble */}
                      {isExu && (
                        <div className="absolute top-2.5 right-2 px-1 flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                          <button
                            title="Favoritar conselho"
                            onClick={() => handleFavorite(msg.id)}
                            className={`p-1 rounded hover:bg-black/40 transition cursor-pointer ${isFav ? "text-yellow-500" : "text-zinc-500"}`}
                          >
                            ★
                          </button>
                        </div>
                      )}

                      {/* Content block */}
                      <p className="whitespace-pre-line tracking-wide pr-7 sm:pr-8 select-text">{msg.text}</p>

                      {/* Info line */}
                      <div className="mt-2 text-[8px] font-mono text-zinc-500 uppercase tracking-widest flex items-center justify-end gap-1.5 selection:bg-transparent">
                        <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        

{msg.id !== "exu_welcome" && isExu && (
  <>
    {Number(msg.xpAwarded || 0) > 0 && (
      <>
        <span>•</span>
        <span className="text-yellow-500 font-bold">
          +{msg.xpAwarded} XP
        </span>
      </>
    )}

    {Number(msg.creditCharged || 0) > 0 && (
      <>
        <span>•</span>
        <span className="text-yellow-500 font-bold">
          -{msg.creditCharged} CRÉDITO AXÉ
        </span>
      </>
    )}
  </>
)}


                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {loading && (
              <div className="flex gap-3 justify-start mr-auto max-w-[80%]">
                <div className="w-8 h-8 rounded-full bg-black border border-red-900 text-yellow-500 flex items-center justify-center shrink-0 animate-pulse text-xs overflow-hidden">
                  <img 
                    src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/ChatGPT-Image-29-de-mai.-de-2026-09_27_07.png" 
                    alt="Exu Responde" 
                    className="w-full h-full object-cover" 
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="bg-zinc-900/60 border border-zinc-800/60 p-3.5 rounded-2xl rounded-tl-none flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  <span className="text-[10px] font-mono text-zinc-500 ml-1.5 uppercase font-medium">Buscando respostas nas águas de Ifá...</span>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* BARRA DE CAMINHOS - FLOATING KEY CONTROLLERS */}
          {user && (
            <div className="grid grid-cols-2 sm:flex sm:flex-row gap-2 pb-2 pt-2 border-t border-zinc-900 select-none w-full">
              <button
                type="button"
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setActiveModal("oracles");
                }}
                className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-red-950/20 border border-zinc-900 hover:border-yellow-500/20 text-[10px] sm:text-xs font-mono font-bold text-yellow-500 inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer transition-all"
              >
                <Compass className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="truncate">ORÁCULOS</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setActiveModal("profile");
                }}
                className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-red-950/20 border border-zinc-900 hover:border-yellow-500/20 text-[10px] sm:text-xs font-mono font-bold text-zinc-300 inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer transition-all"
              >
                <User className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="truncate">MEU PERFIL</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setActiveModal("credits");
                }}
                className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-red-950/20 border border-zinc-900 hover:border-yellow-500/20 text-[10px] sm:text-xs font-mono font-bold inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer text-amber-500 transition-all"
              >
                <Coins className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="truncate">RECARGA (+AXÉ)</span>
              </button>




<button
  type="button"
  onClick={() => {
    AudioEngine.playCrystalBell();
    setShowSupportModal(true);
  }}
  className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-green-950/20 border border-zinc-900 hover:border-green-500/30 text-[10px] sm:text-xs font-mono font-bold inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer text-green-400 transition-all"
>
  <HelpCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
  <span className="truncate">SUPORTE</span>
</button>




              {user.role === "admin" && (
                <button
                  type="button"
                  onClick={() => {
                    AudioEngine.playCrystalBell();
                    setActiveModal("admin");
                  }}
                  className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-red-950/20 border border-red-500/20 hover:border-red-500 text-[10px] sm:text-xs font-mono font-bold text-red-100 inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer transition-all"
                >
                  <Terminal className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                  <span className="truncate">PAINEL</span>
                </button>
              )}
            </div>
          )}

          {/* CAMPO DE PERGUNTA GPT */}
          <div className="pt-2 border-t border-zinc-900">
            {/* Selection of consultation type */}
            <div className="flex gap-1.5 mb-2.5 overflow-x-auto pb-1 select-none scrollbar-none">
              <button
                type="button"
                onClick={() => setConsultationType("comum")}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold border transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                  consultationType === "comum"
                    ? "bg-yellow-500 text-black border-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.2)]"
                    : "bg-black text-zinc-400 border-zinc-900 hover:border-zinc-800 hover:text-zinc-200"
                }`}
              >
                Pergunta comum (01 crédito)
              </button>
              <button
                type="button"
                onClick={() => setConsultationType("outros")}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold border transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                  consultationType === "outros"
                    ? "bg-yellow-500 text-black border-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.2)]"
                    : "bg-black text-zinc-400 border-zinc-900 hover:border-zinc-800 hover:text-zinc-200"
                }`}
              >
                Sobre outra pessoa (02 créditos)
              </button>
              <button
                type="button"
                onClick={() => setConsultationType("completa")}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold border transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                  consultationType === "completa"
                    ? "bg-yellow-500 text-black border-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.2)]"
                    : "bg-black text-zinc-400 border-zinc-900 hover:border-zinc-800 hover:text-zinc-200"
                }`}
              >
                Consulta completa (03 créditos)
              </button>
            </div>

            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                id="campo_pergunta_gpt"
                type="text"
                value={inputText}
                disabled={loading}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={!user ? "Adicione sua pergunta..." : user.credits < (consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1)) ? `Você precisa de pelo menos ${consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1)} créditos para esta consulta...` : "Pergunte sobre sua vida, caminhos, Odu, numerologia, orixás, Exu, prosperidade ou espiritualidade..."}
                className="flex-1 px-4.5 py-3.5 border border-zinc-900 bg-black/80 rounded-xl text-xs sm:text-sm text-yellow-50 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/40 focus:ring-1 focus:ring-yellow-500/30 transition-all font-sans"
              />
              <button
                id="gpt_send_submit_btn"
                type="submit"
                disabled={loading || !inputText.trim()}
                className="px-5 py-3.5 rounded-xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-250 hover:to-amber-500 text-black shadow-md hover:shadow-yellow-500/10 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 disabled:opacity-40"
              >
                <Send className="w-4 h-4 shrink-0" />
              </button>
            </form>

            <div className="flex items-center justify-between text-[9px] font-mono text-zinc-600 mt-2 px-1 uppercase tracking-wider select-none font-bold">
              <span>🛡️ Conexão sagrada encriptada</span>
              <span className="text-yellow-600/70">• Custo: {consultationType === "completa" ? "3 créditos" : (consultationType === "outros" ? "2 créditos" : "1 crédito")}</span>
            </div>
          </div>

        </div>

      </section>

      {/* OVERLAYS MODALS DRAWER ENGINE */}
      <AnimatePresence>
        
        {/* ENTRANCE REGISTER / LOGIN MODAL */}
        {showEntranceModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto"
          >
            <div className="absolute inset-0 select-none pointer-events-none opacity-40 bg-[radial-gradient(circle_at_center,rgba(115,10,10,0.4)_0%,transparent_100%)]">
              <video
  src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/Exu-Responde.mp4"
  className="w-full h-full object-cover filter brightness-[0.7] contrast-[1.15]"
  autoPlay
  loop
  muted
  playsInline
  referrerPolicy="no-referrer"
/>
            </div>
            
            <div className="relative w-full max-w-lg z-10">
              <button
                onClick={() => {
                  AudioEngine.playCrystalBell();
                  setShowEntranceModal(false);
                }}
                className="absolute top-2 right-4 text-zinc-500 hover:text-zinc-200 text-lg font-mono p-2 z-50"
              >
                ✕ FECHAR
              </button>
              <PortalEntrance onLoginSuccess={handleLoginSuccess} />
            </div>
          </motion.div>
        )}

        {/* PROFILE DETAILED DRAWER */}
        {activeModal === "profile" && user && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 180 }}
            className="fixed inset-x-0 bottom-0 top-14 bg-zinc-950 border-t border-yellow-500/20 z-40 flex flex-col shadow-[0_-20px_50px_rgba(0,0,0,0.98)]"
          >
            {/* Header */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 bg-zinc-900 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-500" />
                <h2 className="text-xs sm:text-sm font-black font-mono uppercase tracking-[0.1em] sm:tracking-[0.2em] text-yellow-500 truncate max-w-[240px] sm:max-w-none">MEU PERFIL ESPIRITUAL & SINTONIA</h2>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-full sm:w-auto px-4 py-2.5 sm:py-2 border border-zinc-800 rounded-lg hover:border-zinc-500 text-[10.5px] sm:text-xs font-mono font-bold transition-all cursor-pointer text-center bg-black/40 hover:bg-zinc-900"
              >
                ✕ VOLTAR AO ORÁCULO
              </button>
            </div>

            {/* Scrollable container */}
            <div className="flex-1 overflow-y-auto p-6 sm:p-10 scrolling-pane">
              <div className="max-w-6xl mx-auto">
                <UserProfilePanel 
                  user={user}
                  onUpdateUser={syncUpdatedUser}
                />
              </div>
            </div>
          </motion.div>
        )}

        {/* ORACLES MODAL DRAWER */}
        {activeModal === "oracles" && user && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 180 }}
            className="fixed inset-x-0 bottom-0 top-14 bg-zinc-950 border-t border-yellow-500/20 z-40 flex flex-col shadow-[0_-20px_50px_rgba(0,0,0,0.98)]"
          >
            {/* Header */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 bg-zinc-900 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none">
              <div className="flex items-center gap-2">
                <Compass className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-500" />
                <h2 className="text-xs sm:text-sm font-black font-mono uppercase tracking-[0.1em] sm:tracking-[0.2em] text-yellow-500 truncate max-w-[240px] sm:max-w-none">SABEDORIA ORACULAR (TARÔ E ODUS)</h2>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-full sm:w-auto px-4 py-2.5 sm:py-2 border border-zinc-800 rounded-lg hover:border-zinc-500 text-[10.5px] sm:text-xs font-mono font-bold transition-all cursor-pointer text-center bg-black/40 hover:bg-zinc-900"
              >
                ✕ VOLTAR AO ORÁCULO
              </button>
            </div>

            {/* Scrollable container */}
            <div className="flex-1 overflow-y-auto p-6 sm:p-8 scrolling-pane">
              <div className="max-w-6xl mx-auto">
                <Oraculos 
                  user={user}
                  onUpdateUser={syncUpdatedUser}
                  openCreditsMenu={() => setActiveModal("credits")}
                />
              </div>
            </div>
          </motion.div>
        )}

        {/* PREMIUM PACKAGES RECHARGES DRAWER */}
        {activeModal === "credits" && user && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 180 }}
            className="fixed inset-x-0 bottom-0 top-14 bg-zinc-950 border-t border-yellow-500/20 z-40 flex flex-col shadow-[0_-20px_50px_rgba(0,0,0,0.98)]"
          >
            {/* Header */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 bg-zinc-900 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-500 animate-pulse" />
                <h2 className="text-xs sm:text-sm font-black font-mono uppercase tracking-[0.1em] sm:tracking-[0.2em] text-yellow-500 truncate max-w-[240px] sm:max-w-none font-extrabold">ADQUIRIR CRÉDITOS DE AXÉ</h2>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-full sm:w-auto px-4 py-2.5 sm:py-2 border border-zinc-800 rounded-lg hover:border-zinc-500 text-[10.5px] sm:text-xs font-mono font-bold transition-all cursor-pointer text-center bg-black/40 hover:bg-zinc-900"
              >
                ✕ VOLTAR AO ORÁCULO
              </button>
            </div>

            {/* Scrollable container */}
            <div className="flex-1 overflow-y-auto p-6 sm:p-10 scrolling-pane">
              <div className="max-w-4xl mx-auto">
                <div className="text-center mb-8">
                  <h3 className="text-xl font-bold uppercase tracking-wider text-amber-100 font-mono">Energize suas Correntes</h3>
                  <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
                    Escolha um pacote energética de créditos Axé oficial e mantenha sua linha direta de consulta e orientação descompromissada ativa no templo.
                  </p>
                </div>
                <PremiumCredits 
                  user={user}
                  onUpdateUser={syncUpdatedUser}
                  onClose={() => setActiveModal(null)}
                />
              </div>
            </div>
          </motion.div>
        )}



        {/* ADMINISTRATIVE AUDITING CONTROL PANEL */}
        {activeModal === "admin" && user && user.role === "admin" && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 180 }}
            className="fixed inset-x-0 bottom-0 top-14 bg-zinc-950 border-t border-yellow-500/20 z-40 flex flex-col shadow-[0_-20px_50px_rgba(0,0,0,0.98)]"
          >
            {/* Header */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 bg-zinc-900 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 sm:w-5 sm:h-5 text-red-500 animate-pulse" />
                <h2 className="text-xs sm:text-sm font-black font-mono uppercase tracking-[0.1em] sm:tracking-[0.2em] text-red-400 truncate max-w-[240px] sm:max-w-none">PAINEL ADMINISTRATIVO • EXU AUDITING</h2>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-full sm:w-auto px-4 py-2.5 sm:py-2 border border-zinc-800 rounded-lg hover:border-zinc-500 text-[10.5px] sm:text-xs font-mono font-bold transition-all cursor-pointer text-center bg-black/40 hover:bg-zinc-900"
              >
                ✕ VOLTAR AO ORÁCULO
              </button>
            </div>

            {/* Scrollable container */}
            <div className="flex-1 overflow-y-auto p-6 sm:p-10 scrolling-pane">
              <div className="max-w-6xl mx-auto">
                <AdminPanel user={user} />
              </div>
            </div>
          </motion.div>
        )}


{showSupportModal && (
  <motion.div
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    className="fixed inset-0 z-[99999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4"
  >
    <div className="w-full max-w-sm rounded-3xl border border-yellow-500/30 bg-zinc-950 p-5 shadow-[0_0_35px_rgba(234,179,8,0.25)]">
      <h2 className="mb-5 text-center text-lg font-black text-yellow-400 tracking-widest">
        SUPORTE
      </h2>

      <button
        type="button"
        onClick={() =>
          window.open(
            "https://chat.whatsapp.com/JqXdWPrCVxz1NC9dXyMdso?s=cl&p=a&ilr=2&amv=1",
            "_blank"
          )
        }
        className="mb-4 w-full rounded-2xl bg-green-600 py-4 font-bold text-white"
      >
        🟢 Entrar no WhatsApp
      </button>

      <button
        type="button"
        onClick={() =>
          window.open(
            "https://t.me/+EOUhr0Xa2_00NDQ5",
            "_blank"
          )
        }
        className="mb-4 w-full rounded-2xl bg-sky-600 py-4 font-bold text-white"
      >
        🔵 Entrar no Telegram
      </button>

      <button
        type="button"
        onClick={() => setShowSupportModal(false)}
        className="w-full rounded-2xl bg-red-700 py-3 font-bold text-white"
      >
        Fechar
      </button>
    </div>
  </motion.div>
)}



      </AnimatePresence>
    </main>
  );
}
