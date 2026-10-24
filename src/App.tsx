/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { auth, onAuthStateChanged, signOut } from "./firebase";
import { 
  Sparkles, LogIn, LogOut, Flame, Volume2, VolumeX, Send,
  BookOpen, User, Coins, Award, ShieldCheck, Terminal, HelpCircle, 
  RotateCcw, Trash2, Bookmark, Star, ChevronDown, CheckCircle
} from "lucide-react";
import { AudioEngine } from "./components/AudioEngine";
import { UserProfile, ChatMessage } from "./types";
import { parseApiResponse, apiFetch, generateIdempotencyKey } from "./api";

// Import custom built components
import PortalEntrance from "./components/PortalEntrance";
import UserProfilePanel from "./components/UserProfile";
import PremiumCredits from "./components/PremiumCredits";
import AdminPanel from "./components/AdminPanel";
import LegalModal, { LegalTab } from "./components/LegalModal";

type PendingConsultation = {
  key: string;
  userId: string;
  firebaseUid: string;
  text: string;
  type: "comum" | "outros" | "completa";
  createdAt: string;
};

type ChatApiResult = {
  success?: boolean;
  error?: string;
  code?: string;
  refunded?: boolean;
  alreadyProcessed?: boolean;
  exuMessage?: ChatMessage;
  xpAwarded?: number;
};

const pendingStorageKey = (uid: string) => `exu_pending_consultation_v1:${uid}`;

function readPendingConsultation(uid: string, userId: string): PendingConsultation | null {
  const saved = sessionStorage.getItem(pendingStorageKey(uid));
  if (!saved) return null;
  const value = JSON.parse(saved) as PendingConsultation;
  if (
    !value || value.firebaseUid !== uid || value.userId !== userId ||
    typeof value.key !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.key) ||
    typeof value.text !== "string" || !value.text.trim() ||
    !["comum", "outros", "completa"].includes(value.type) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Não foi possível recuperar a consulta pendente. Entre em contato com o suporte antes de reenviar a pergunta.");
  }
  return value;
}

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
  const [activeModal, setActiveModal] = useState<"profile" | "library" | "credits" | "admin" | null>(null);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [legalModalTab, setLegalModalTab] = useState<LegalTab>("termos");
  const [libraryTab, setLibraryTab] = useState<"odus" | "exus" | "arcades">("odus");

  const openLegalModal = (tab: LegalTab = "termos") => {
    setLegalModalTab(tab);
    setLegalModalOpen(true);
  };

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const currentUserRef = useRef(user);
  currentUserRef.current = user;
  const [pendingConsultation, setPendingConsultation] = useState<PendingConsultation | null>(null);
  const [pendingStorageError, setPendingStorageError] = useState("");

  useEffect(() => {
    setPendingConsultation(null);
    setPendingStorageError("");
    const uid = auth.currentUser?.uid;
    if (uid && user?.id) {
      try {
        setPendingConsultation(readPendingConsultation(uid, user.id));
      } catch (error) {
        setPendingStorageError(error instanceof Error ? error.message : "Não foi possível acessar a consulta pendente.");
      }
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
      sendingRef.current = false;
    };
  }, [user?.id]);

  useEffect(() => {
    setLoading(false);
  }, [user?.id]);

  // Load user session









   useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser || !firebaseUser.email) {
        setUser(null);
        setMessages([]);
        setInputText("");
        setConsultationType("comum");
        setShowEntranceModal(true);
        setCheckedAuth(true);
        return;
      }

      if (!firebaseUser.emailVerified) {
        setUser(null);
        setShowEntranceModal(true);
        setCheckedAuth(true);
        return;
      }

      try {
        const token = await firebaseUser.getIdToken();

        const loginRes = await apiFetch("/api/auth/login", {
          method: "POST",
          token,
          body: JSON.stringify({
            email: firebaseUser.email
          })
        });

        const loginData = await parseApiResponse<{
          user?: UserProfile;
          error?: string;
        }>(loginRes);

        if (!loginRes.ok || !loginData.user) {
          throw new Error(
            loginData.error || "Não foi possível restaurar a sessão."
          );
        }

        const restoredUser = loginData.user as UserProfile;

        setUser(restoredUser);
        setShowEntranceModal(false);

        const profileRes = await apiFetch("/api/user/profile", {
          token
        });

        const profileData = await parseApiResponse<{
          chats?: ChatMessage[];
          error?: string;
        }>(profileRes);

        if (
          profileRes.ok &&
          Array.isArray(profileData.chats) &&
          profileData.chats.length > 0
        ) {
          // Garante IDs únicos para evitar chaves duplicadas no React
          const sanitized = profileData.chats.map((c, i) => ({
            ...c,
            id: c.id ? `${c.id}_${i}` : `chat_${Date.now()}_${i}`
          }));
          setMessages(sanitized);
        } else {
          setDefaultGreeting(restoredUser);
        }
      } catch (error) {
        console.error("Erro ao restaurar sessão:", error);

        setUser(null);
        setMessages([]);
        setShowEntranceModal(true);
      } finally {
        setCheckedAuth(true);
      }
    });

    return () => unsubscribe();
  }, []);










  // Set default initial greeting if chat is fresh
  const setDefaultGreeting = (currentUser: UserProfile) => {
    setMessages([
      {
        id: "exu_welcome_" + Date.now(),
        userId: currentUser.id,
        sender: "exu",
        text: `Bem Vindo Ao Reino De Exu! Faça Sua Pergunta.`,
        timestamp: new Date().toISOString()
      }
    ]);
  };

  // Move somente a conversa. A resposta começa pelo início, sem seguir a rolagem do leitor.
  useEffect(() => {
    const container = chatContainerRef.current;
    const lastMessage = messages[messages.length - 1];
    if (!container || !lastMessage) return;
    const frame = requestAnimationFrame(() => {
      if (lastMessage.sender === "exu" && lastMessageRef.current) {
        container.scrollTo({ top: Math.max(0, lastMessageRef.current.offsetTop - 12), behavior: "auto" });
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

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

  



  const handleLoginSuccess = async (loggedInUser: UserProfile) => {
    setUser(loggedInUser);
    setShowEntranceModal(false);

    AudioEngine.playPortalSwoosh();

    if (soundEnabled) {
      AudioEngine.playDrone();
    }

    try {
      const firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        setDefaultGreeting(loggedInUser);
        return;
      }

      const token = await firebaseUser.getIdToken();

      const profileRes = await apiFetch("/api/user/profile", {
        token
      });

      const profileData = await profileRes.json();

      if (
        profileRes.ok &&
        Array.isArray(profileData.chats) &&
        profileData.chats.length > 0
      ) {
        const sanitized = profileData.chats.map((c, i) => ({
          ...c,
          id: c.id ? `${c.id}_${i}` : `chat_${Date.now()}_${i}`
        }));
        setMessages(sanitized);
      } else {
        setDefaultGreeting(loggedInUser);
      }
    } catch (error) {
      console.error("Erro ao carregar histórico:", error);
      setDefaultGreeting(loggedInUser);
    }
  };

  const handleLogout = async () => {
    AudioEngine.playPortalSwoosh();
    AudioEngine.stopDrone();

    try {
      await signOut(auth);
    } catch (error) {
      console.error("Erro ao encerrar sessão Firebase:", error);
    }

    setUser(null);
    setMessages([]);
    setInputText("");
    setConsultationType("comum");
    setShowEntranceModal(true);
    setActiveModal(null);

    localStorage.removeItem(SESSION_KEY);
  };







  const syncUpdatedUser = (updatedUser: UserProfile) => {
    setUser(updatedUser);
  };

  // Uma chave por consulta: a recuperação reutiliza pergunta, modalidade e chave originais.
  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (sendingRef.current || loading) return;
    const account = user;
    const firebaseUser = auth.currentUser;
    if (!account || !firebaseUser) {
      setShowEntranceModal(true);
      return;
    }

    let consultation: PendingConsultation;
    let recovering = false;
    try {
      const saved = readPendingConsultation(firebaseUser.uid, account.id);
      recovering = Boolean(saved);
      if (saved) {
        consultation = saved;
      } else {
        const question = inputText.trim();
        if (!question) return;
        if (question.length > 2000) {
          setPendingStorageError("A pergunta deve ter no máximo 2.000 caracteres.");
          return;
        }
        if (account.credits < 5) {
          setActiveModal("credits");
          return;
        }
        consultation = {
          key: generateIdempotencyKey(),
          userId: account.id,
          firebaseUid: firebaseUser.uid,
          text: question,
          type: consultationType,
          createdAt: new Date().toISOString(),
        };
        // Salva antes do envio para preservar a chave mesmo após atualizar esta aba.
        sessionStorage.setItem(pendingStorageKey(firebaseUser.uid), JSON.stringify(consultation));
      }
    } catch (error) {
      setPendingStorageError(error instanceof Error ? error.message : "O navegador não permitiu guardar a consulta. Nenhuma nova pergunta foi enviada.");
      return;
    }

    sendingRef.current = true;
    setLoading(true);
    setPendingStorageError("");
    setPendingConsultation(consultation);
    setInputText("");
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 70_000);
    const isCurrentAccount = () =>
      auth.currentUser?.uid === consultation.firebaseUid &&
      currentUserRef.current?.id === consultation.userId &&
      requestRef.current === controller;

    const clearPending = () => {
      sessionStorage.removeItem(pendingStorageKey(consultation.firebaseUid));
      if (isCurrentAccount()) setPendingConsultation(null);
    };

    const showMessage = (text: string, id: string) => {
      if (!isCurrentAccount()) return;
      const message: ChatMessage = {
        id, userId: account.id, sender: "exu", text,
        timestamp: new Date().toISOString(),
      };
      setMessages(previous => [...previous.filter(item => item.id !== id), message]);
    };

    if (!recovering) {
      setMessages(previous => [...previous, {
        id: `usr_${consultation.key}`,
        userId: account.id,
        sender: "user",
        text: consultation.text,
        timestamp: consultation.createdAt,
      }]);
    }

    try {
      const token = await firebaseUser.getIdToken();
      if (!isCurrentAccount() || controller.signal.aborted) return;
      const response = await apiFetch("/api/exu/chat", {
        method: "POST",
        token,
        idempotencyKey: consultation.key,
        signal: controller.signal,
        body: JSON.stringify({
          text: consultation.text,
          type: consultation.type,
          idempotencyKey: consultation.key,
        }),
      });
      const data = await parseApiResponse<ChatApiResult>(response);
      if (!isCurrentAccount()) return;

      if (!response.ok) {
        const terminalRefund = data.code === "KEY_ALREADY_REFUNDED";
        // Esses status, na primeira tentativa, correspondem à rejeição antes do débito.
        const rejectedBeforeDebit = !recovering && [401, 402, 403, 413, 422, 429].includes(response.status);
        if (data.refunded === true || terminalRefund || rejectedBeforeDebit) {
          clearPending();
          setInputText(consultation.text);
          showMessage(
            data.error || "A solicitação não foi concluída. Confira sua conta antes de tentar novamente.",
            `err_${consultation.key}`,
          );
        } else {
          showMessage(
            `${data.error || "Ainda não foi possível confirmar o resultado da consulta."} Use “Verificar consulta pendente” para consultar novamente com a mesma identificação.`,
            `err_${consultation.key}`,
          );
        }
      } else if (
        data.success === false || !data.exuMessage ||
        typeof data.exuMessage.text !== "string" || !data.exuMessage.text.trim()
      ) {
        throw new Error("O servidor não retornou uma resposta válida. A consulta foi mantida para verificação.");
      } else {
        const reply = data.exuMessage;
        const answer: ChatMessage = {
          ...reply,
          id: reply.id || `exu_${consultation.key}`,
          userId: account.id,
          sender: "exu",
          timestamp: reply.timestamp || new Date().toISOString(),
          xpAwarded: Number.isFinite(data.xpAwarded) ? data.xpAwarded : 0,
        };
        setMessages(previous => [
          ...previous.filter(item =>
            item.id !== `err_${consultation.key}` &&
            item.id !== answer.id &&
            !(item.sender === "exu" && item.timestamp === answer.timestamp && item.text === answer.text)
          ),
          answer,
        ]);
        clearPending();
      }

      // Busca a conta atual: não reaplica saldo histórico nem soma XP de resposta repetida.
      try {
        const profileResponse = await apiFetch("/api/user/profile", { token, signal: controller.signal });
        const profile = await parseApiResponse<{ user?: UserProfile }>(profileResponse);
        if (profileResponse.ok && profile.user?.id === account.id && isCurrentAccount()) {
          setUser(profile.user);
        }
      } catch {
        // A falha ao atualizar o perfil não descarta a resposta nem reenvia a consulta.
      }
    } catch (error) {
      showMessage(
        controller.signal.aborted
          ? "O tempo de espera terminou, mas isso não confirma se a consulta foi concluída. Use “Verificar consulta pendente” para recuperar o resultado com a mesma identificação."
          : `${error instanceof Error ? error.message : "A conexão foi interrompida."} Use “Verificar consulta pendente” antes de iniciar outra consulta.`,
        `err_${consultation.key}`,
      );
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        sendingRef.current = false;
        setLoading(false);
      }
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
        #chat_container {
          scrollbar-width: auto;
          scrollbar-color: #b45309 #18181b;
        }
        #chat_container::-webkit-scrollbar { width: 8px; }
        #chat_container::-webkit-scrollbar-track { background: #18181b; }
        #chat_container::-webkit-scrollbar-thumb { background: #b45309; border-radius: 9px; }
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
  <img
  id="vinhete_video"
  src="/images/Exu Responde Fundo.png"
  alt=""
  className="w-full h-full object-cover"
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
        key={`energy_ember_${i}`}
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
                <div className="w-6.5 h-6.5 rounded-full overflow-hidden border border-yellow-500/30">
  <img
    src="/images/Exu Responde Logo.png"
    alt="Exu Responde"
    className="w-full h-full object-cover"
  />
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
  src="/images/Exu Responde Logo.png"
  alt="Exu Responde"
  className="relative z-10 w-full h-full object-cover"
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

          <div id="chat_container" ref={chatContainerRef} className="relative flex-1 min-h-0 overflow-y-scroll pr-1 space-y-4 scrolling-pane select-text" style={{ scrollbarGutter: "stable", overflowAnchor: "none" }}>
            
            {/* Standard Welcome layout fallback or Message Logs */}
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center h-full text-zinc-500">
                <p className="text-xs uppercase tracking-widest font-mono">Nenhuma consulta iniciada nesta encruzilhada.</p>
                <p className="text-[11px] font-mono text-zinc-600 mt-2">Sua jornada de conselho espiritual começa quando escrever abaixo.</p>
              </div>
            ) : (
              messages.map((msg, index) => {
                const isExu = msg.sender === "exu";
                const isFav = favorites.includes(msg.id);
                const uniqueKey = `${msg.id || "msg"}-${msg.timestamp || ""}-${index}`;

                return (
                  <div
                    key={uniqueKey}
                    ref={index === messages.length - 1 ? lastMessageRef : null}
                    className={`flex gap-3 max-w-full sm:max-w-[90%] pb-1 ${isExu ? "mr-auto text-left" : "ml-auto flex-row-reverse text-right"}`}
                  >
                    {/* Small avatar circle */}
                    <div className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 overflow-hidden font-mono text-xs select-none ${
                      isExu ? "bg-black border-red-900 text-yellow-500" : "bg-red-950/20 border-red-500/10 text-red-400"
                    }`}>
                      {isExu ? (
                        <img 
                          src="/images/Exu Responde Logo.png" 
                          alt="Exu Responde" 
                          className="w-full h-full object-cover" 
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
          -{msg.creditCharged} CRÉDITOS AXÉ
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
                    src="/images/Exu Responde Logo.png" 
                    alt="Exu Responde" 
                    className="w-full h-full object-cover" 
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

            <div aria-hidden="true" />
          </div>

          {/* BARRA DE CAMINHOS - FLOATING KEY CONTROLLERS */}
          {user && (
            <div className="grid grid-cols-2 sm:flex sm:flex-row gap-2 pb-2 pt-2 border-t border-zinc-900 select-none w-full">
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

<button
  type="button"
  onClick={() => {
    AudioEngine.playCrystalBell();
    openLegalModal("termos");
  }}
  className="w-full sm:flex-1 px-1.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-yellow-950/20 border border-zinc-900 hover:border-yellow-500/30 text-[10px] sm:text-xs font-mono font-bold inline-flex items-center justify-center gap-1 sm:gap-1.5 cursor-pointer text-yellow-500/90 transition-all"
>
  <ShieldCheck className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
  <span className="truncate">LEGAL</span>
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
            {pendingStorageError && (
              <p role="alert" className="mb-2 text-sm text-amber-200">{pendingStorageError}</p>
            )}
            {pendingConsultation?.userId === user?.id && pendingConsultation && (
              <div className="mb-2 rounded-xl border border-amber-500/40 bg-black/80 p-3">
                <p className="text-xs text-amber-100 mb-2">
                  {loading ? "Aguardando a resposta da consulta…" : "Há uma consulta aguardando confirmação. Verifique o resultado antes de enviar outra pergunta."}
                </p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { void handleSendMessage(); }}
                  className="rounded-lg border border-amber-500/60 px-3 py-2 text-sm text-amber-200 disabled:opacity-50"
                >
                  {loading ? "Aguarde…" : "Verificar consulta pendente"}
                </button>
              </div>
            )}
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                id="campo_pergunta_gpt"
                type="text"
                value={inputText}
                disabled={loading || Boolean(pendingConsultation)}
                maxLength={2000}
                aria-label="Sua pergunta para Exu"
                onChange={(e) => setInputText(e.target.value)}
                placeholder={!user ? "Adicione sua pergunta..." : user.credits < 5 ? "Você precisa de pelo menos 5 créditos para esta pergunta..." : "Pergunte sobre sua vida, caminhos, Odu, numerologia, orixás, Exu, prosperidade ou espiritualidade..."}
                className="flex-1 px-4.5 py-3.5 border border-zinc-900 bg-black/80 rounded-xl text-xs sm:text-sm text-yellow-50 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/40 focus:ring-1 focus:ring-yellow-500/30 transition-all font-sans"
              />
              <button
                id="gpt_send_submit_btn"
                type="submit"
                disabled={loading || Boolean(pendingConsultation) || !inputText.trim()}
                aria-label="Enviar pergunta"
                className="px-5 py-3.5 rounded-xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-250 hover:to-amber-500 text-black shadow-md hover:shadow-yellow-500/10 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 disabled:opacity-40"
              >
                <Send className="w-4 h-4 shrink-0" />
              </button>
            </form>

            <div className="flex flex-wrap items-center justify-between text-[9px] font-mono text-zinc-600 mt-2 px-1 uppercase tracking-wider select-none font-bold gap-2">
              <div className="flex items-center gap-2">
                <span>🛡️ Conexão sagrada encriptada</span>
                <span className="text-yellow-600/70">• Custo: 5 créditos</span>
              </div>
              <div className="flex items-center gap-2 text-zinc-500">
                <button
                  type="button"
                  onClick={() => openLegalModal("termos")}
                  className="hover:text-yellow-500 cursor-pointer underline"
                >
                  Termos
                </button>
                <span>•</span>
                <button
                  type="button"
                  onClick={() => openLegalModal("privacidade")}
                  className="hover:text-yellow-500 cursor-pointer underline"
                >
                  Privacidade & LGPD
                </button>
                <span>•</span>
                <button
                  type="button"
                  onClick={() => openLegalModal("responsabilidade")}
                  className="hover:text-yellow-500 cursor-pointer underline"
                >
                  Ética
                </button>
              </div>
            </div>
          </div>

        </div>

      </section>

      {/* OVERLAYS MODALS DRAWER ENGINE */}
      <AnimatePresence>
        
        {/* ENTRANCE REGISTER / LOGIN MODAL */}
        {showEntranceModal && (
          <motion.div
            key="entrance_modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto"
          >
            <div className="absolute inset-0 select-none pointer-events-none opacity-40 bg-[radial-gradient(circle_at_center,rgba(115,10,10,0.4)_0%,transparent_100%)]">
              <img
  src="/images/Exu Responde Fundo.png"
  alt=""
  className="w-full h-full object-cover filter brightness-[0.7] contrast-[1.15]"
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
            key="profile_drawer"
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

        {/* PREMIUM PACKAGES RECHARGES DRAWER */}
        {activeModal === "credits" && user && (
          <motion.div
            key="credits_drawer"
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
            key="admin_drawer"
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

        {/* SUPPORT MODAL */}
        {showSupportModal && (
          <motion.div
            key="support_modal"
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

      {/* Global Legal Modal */}
      <LegalModal
        isOpen={legalModalOpen}
        initialTab={legalModalTab}
        onClose={() => setLegalModalOpen(false)}
      />
    </main>
  );
}
