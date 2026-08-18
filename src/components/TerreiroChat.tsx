/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Sparkles, MessageSquare, Compass, Shield, Flame, BookOpen, Volume2 } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, ChatMessage } from "../types";

interface TerreiroChatProps {
  user: UserProfile;
  initialChats?: ChatMessage[];
  onUpdateUser: (updated: UserProfile) => void;
  openCreditsMenu: () => void;
}

const TEMPLE_SUGGESTIONS = [
  "Estou numa encruzilhada profissional, Exu. Qual caminho devo trilhar?",
  "O que as forças de Ifá me dizem sobre transmutar energias negativas?",
  "Maria Padilha, me mostre o melhor caminho para harmonizar meu relacionamento.",
  "Estou sentindo estagnação financeira. Como posso reativar meu axé de prosperidade?",
  "Quais cautelas devo ter no meu dia a dia segundo o equilíbrio dos Odùs?"
];

export default function TerreiroChat({ user, initialChats = [], onUpdateUser, openCreditsMenu }: TerreiroChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialChats);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [typingEffectState, setTypingEffectState] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [consultationType, setConsultationType] = useState<"comum" | "outros" | "completa">("comum");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize messages if none exist
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: "welcome_msg",
          userId: user.id,
          sender: "exu",
          text: `Laroyé, ${user.name}! Sou Exu Responde, guardião dos caminhos e detentor dos saberes de Ifá. Traga-me as tormentas de sua mente, mostre-me suas encruzilhadas corporais ou intelectuais e buscaremos o axé da clareza juntos. Cada conselho consome 1 crédito de axé e nutre seu espírito em +15 XP.`,
          timestamp: new Date().toISOString()
        }
      ]);
    }
  }, [user.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingEffectState]);

  const handleSendMessage = async (textToSend: string) => {
    if (!textToSend.trim()) return;
    const requiredCredits = consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1);
    if (user.credits < requiredCredits) {
      AudioEngine.playPortalSwoosh();
      openCreditsMenu();
      return;
    }

    setLoading(true);
    setInputText("");
    AudioEngine.playCrystalBell();

    // Create temporary user message locally
    const userMsg: ChatMessage = {
      id: "usr_temp_" + Date.now(),
      userId: user.id,
      sender: "user",
      text: textToSend,
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
        body: JSON.stringify({ text: textToSend, type: consultationType })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "O portal místico fechou temporariamente.");
      }

      // Append bot response and trigger incremental typing animation
      const botMsg: ChatMessage = data.exuMessage;

      setMessages(prev => [...prev, botMsg]);

      // Deduct client credit & add XP
      onUpdateUser({
        ...user,
        credits: data.creditsLeft,
        xp: user.xp + (data.xpAwarded || 15),
        level: data.newLevel
      });

    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: "err_temp_" + Date.now(),
        userId: user.id,
        sender: "exu",
     text: `⚠️ Alerta espiritual: ${
  typeof err?.message === "string"
    ? err.message
    : typeof err === "string"
      ? err
      : "Houve uma oscilação na ponte cósmica. Seus créditos foram preservados no terreiro."
}`,
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    if (loading) return;
    handleSendMessage(suggestion);
  };

  const toggleFavorite = (id: string) => {
    if (favorites.includes(id)) {
      setFavorites(favorites.filter(fid => fid !== id));
    } else {
      setFavorites([...favorites, id]);
      AudioEngine.playCrystalBell();
    }
  };

  const speakMessage = (text: string) => {
    AudioEngine.playPortalSwoosh();
    // Use fallback speech synthesis inside browser if supported
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const cleanText = text.replace(/[*#🔱🔥]/g, "");
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = "pt-BR";
      utterance.rate = 0.95;
      utterance.pitch = 0.8; // slightly deep tone
      window.speechSynthesis.speak(utterance);
    }
  };

  return (
    
<div id="terreiro_chat_panel" className="flex flex-col h-full bg-zinc-950/80 border border-red-950/40 rounded-3xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.85)] backdrop-blur-md">
     

 {/* Top Header details */}
      <div className="px-6 py-4 bg-gradient-to-r from-red-950/40 via-black to-red-950/40 border-b border-red-950/60 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Animated small fire node */}
          <div className="relative flex items-center justify-center">
            <span className="absolute animate-ping w-3 h-3 bg-red-600 rounded-full opacity-75" />
            <Flame className="w-5 h-5 text-yellow-500 relative z-10" />
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-[0.2em] text-yellow-500 uppercase">Terreiro Virtual</h3>
            <span className="text-[10px] font-mono text-zinc-400">EXU RESPONDE • CONSELHO DE LUZ ASTRAL</span>
          </div>
        </div>

        {/* User Axé credits display */}
        <div className="flex items-center gap-2 border border-yellow-500/20 px-3 py-1.5 rounded-full bg-black/60 shadow-[inset_0_1px_8px_rgba(234,179,8,0.05)]">
          <Compass className="w-3.5 h-3.5 text-yellow-500 animate-spin" style={{ animationDuration: "12s" }} />
          <span className="text-[10px] font-mono text-zinc-300">CRÉDITOS AXÉ:</span>
          <span className="text-xs font-mono font-bold text-yellow-400">{user.credits}</span>
        </div>
      </div>

      {/* Main chat log */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6 scrollbar-thin scrollbar-thumb-amber-800 scrollbar-track-zinc-950">
        
        {/* Immersive Avatar Visual Hero Section */}
        <div className="border border-red-950/50 rounded-2xl bg-[radial-gradient(ellipse_at_center,rgba(60,0,0,0.22)_0%,rgba(0,0,0,1)_100%)] p-6 text-center max-w-md mx-auto mb-6 relative overflow-hidden flex flex-col items-center">
          
          {/* Background ritual circles decor */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-yellow-600 via-amber-500 to-red-600" />
          
          <div className="relative w-full max-w-xs aspect-video mb-3.5 rounded-xl border-2 border-yellow-500/30 overflow-hidden shadow-[0_0_15px_rgba(234,179,8,0.2)] select-none bg-black">
            <video
              src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/Exu-Responde.mp4"
              className="w-full h-full object-cover"
              autoPlay
              loop
              muted
              playsInline
              referrerPolicy="no-referrer"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent pointer-events-none" />
          </div>

          <h4 className="text-yellow-400 text-xs font-bold font-mono tracking-widest uppercase">EXU ELEGBARA</h4>
          <p className="text-[11px] text-zinc-400 mt-1 max-w-sm leading-normal">
            "Eu vejo sete chaves para as suas encruzilhadas, mas o livre-arbítrio só exige a coragem de segurar uma delas."
          </p>
        </div>

        {/* Message items */}
        <AnimatePresence initial={false}>
          {messages.map((msg) => {
            const isExu = msg.sender === "exu";
            const isFavorite = favorites.includes(msg.id);

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className={`flex gap-3 max-w-[85%] ${isExu ? "mr-auto text-left" : "ml-auto flex-row-reverse text-right"}`}
              >
                {/* Message Icon bubble */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 overflow-hidden border text-xs font-mono select-none ${
                  isExu ? "bg-black border-red-900/60 text-yellow-500 shadow-[0_2px_8px_rgba(234,179,8,0.1)]" : "bg-red-950/40 border-red-500/20 text-red-400"
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

                {/* Message Body card */}
                <div className={`p-4 rounded-2xl select-text relative group transition-all ${
                  isExu ? "bg-zinc-900/90 border border-zinc-800 text-amber-50 rounded-tl-none shadow-md" : "bg-gradient-to-b from-red-950/60 to-zinc-950 border border-red-950/50 text-amber-100 rounded-tr-none"
                }`}>
                  
                  {/* Glowing core decor for oracolar content */}
                  {isExu && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                      <button
                        title="Favoritar conselho"
                        onClick={() => toggleFavorite(msg.id)}
                        className={`p-1 rounded hover:bg-black/40 transition-all cursor-pointer ${isFavorite ? 'text-yellow-500' : 'text-zinc-500'}`}
                      >
                        ★
                      </button>
                    </div>
                  )}

                  {/* Message Paragraphs */}
                  <div className="text-sm font-sans leading-relaxed whitespace-pre-wrap select-text selection:bg-red-900 selection:text-white">
                    {msg.text}
                  </div>

                  {/* Timestamp row */}
                  <div className="mt-2 text-[9px] font-mono text-zinc-500 tracking-wider flex items-center gap-2 justify-end">
                    <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {msg.id === "welcome_msg" ? null : (
                      <>
                        <span className="text-zinc-600">•</span>
                        <span className="text-yellow-600 uppercase font-bold">{isExu ? "-1 CRÉDITO AXÉ" : "+15 XP"}</span>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Mock typing indicator */}
        {loading && (
          <div className="flex gap-3 justify-start mr-auto max-w-[80%]">
            <div className="w-8 h-8 rounded-full bg-black border border-red-900/40 text-yellow-500 flex items-center justify-center shrink-0 animate-pulse text-xs font-mono overflow-hidden">
              <img 
                src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/ChatGPT-Image-29-de-mai.-de-2026-09_27_07.png" 
                alt="Exu Responde" 
                className="w-full h-full object-cover" 
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="bg-zinc-900/60 border border-zinc-800 p-4 rounded-2xl rounded-tl-none flex items-center gap-1.5 shadow-md">
              <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              <span className="text-xs font-mono text-zinc-500 ml-1.5 uppercase font-semibold">Decifrando caminhos...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Floating suggestion drawer inside chat */}
      <div className="px-6 py-2 bg-black/40 border-t border-red-950/20">
        <label className="text-[9px] font-mono text-zinc-500 tracking-wider uppercase block mb-1.5">Sugestões de questionamentos espirituais aos caminhos:</label>
        <div className="flex gap-2 overflow-x-auto pb-1.5 select-none scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
          {TEMPLE_SUGGESTIONS.map((sug, idx) => (
            <button
              key={idx}
              onClick={() => handleSuggestionClick(sug)}
              disabled={loading}
              className="text-xs bg-zinc-950 hover:bg-red-950/20 border border-red-950 px-3 py-1.5 rounded-lg text-amber-200/80 hover:text-amber-100 hover:border-yellow-600/40 shrink-0 select-none cursor-pointer transition-all duration-300 disabled:opacity-50"
            >
              {sug.substring(0, 48)}...
            </button>
          ))}
        </div>
      </div>

      {/* Chat bottom input controller */}
      <div className="p-4 bg-zinc-950 border-t border-red-950/50">
        {/* Selection of consultation type */}
        <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 select-none scrollbar-none">
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage(inputText);
          }}
          className="flex gap-2"
        >
          <input
            id="chat_input_text"
            type="text"
            value={inputText}
            disabled={loading}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={user.credits < (consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1)) ? `Você precisa de pelo menos ${consultationType === "completa" ? 3 : (consultationType === "outros" ? 2 : 1)} créditos para esta consulta...` : "Digite sua dúvida espiritual ou filosófica..."}
            className="flex-1 px-4 py-3 border border-red-950 bg-black rounded-xl text-amber-100 placeholder-zinc-700 focus:outline-none focus:border-yellow-600/60 focus:ring-1 focus:ring-yellow-600/60 transition-all text-sm font-sans autofill:bg-black"
          />
          <button
            id="chat_send_btn"
            type="submit"
            disabled={loading || !inputText.trim()}
            className="px-5 py-3 rounded-xl font-bold bg-gradient-to-b from-yellow-400 to-amber-600 hover:from-yellow-300 hover:to-amber-500 text-black shadow-md hover:shadow-lg hover:shadow-yellow-500/10 cursor-pointer active:scale-95 disabled:opacity-40 transition-all"
          >
            <Send className="w-4 h-4 shrink-0" />
          </button>
        </form>

        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-2.5 px-1 uppercase tracking-wide">
          <span>🛡️ Consultas seguras e encriptadas</span>
          <span className="text-yellow-600/80 font-semibold">• Custo: {consultationType === "completa" ? "3 créditos" : (consultationType === "outros" ? "2 créditos" : "1 crédito")}</span>
        </div>
      </div>

    </div>
  );
}
