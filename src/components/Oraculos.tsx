/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, Compass, Flame, Calendar, Award, BookOpen, Clock, Heart, DollarSign, Key, Info } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, TarotCard } from "../types";
import { auth, onAuthStateChanged } from "../firebase";
import { apiFetch, generateIdempotencyKey } from "../api";

interface OraculosProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
  openCreditsMenu: () => void;
}

type ActiveOracleTab = "tarot" | "buzios" | "numerology" | "astrology";

type PaidOracle = ActiveOracleTab;
interface PendingOracle {
  version: 1;
  key: string;
  userId: string;
  uid: string;
  kind: PaidOracle;
  payload: Record<string, string | number>;
}
const ORACLE_PATHS: Record<PaidOracle, string> = {
  tarot: "/api/oraculo/tarot", buzios: "/api/oraculo/buzios", numerology: "/api/oraculo/numerologia", astrology: "/api/oraculo/astrologia",
};

export default function Oraculos(props: OraculosProps) {
  const [uid, setUid] = useState(auth.currentUser?.uid || "");
  useEffect(() => onAuthStateChanged(auth, (account) => setUid(account?.uid || "")), []);
  return <OracleSession key={`${props.user.id}:${uid}`} {...props} uid={uid} />;
}

function OracleSession({ user, onUpdateUser, openCreditsMenu, uid }: OraculosProps & { uid: string; key?: string }) {
  const [activeTab, setActiveTab] = useState<ActiveOracleTab>("tarot");
  const ORACLE_COST_AXE = 5;

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

  // --- BUZIOS ORACLE STATE (16 CONCHAS) ---
  const [buziosQuestion, setBuziosQuestion] = useState("");
  const [buziosLoading, setBuziosLoading] = useState(false);
  const [buziosError, setBuziosError] = useState("");
  const [buziosResult, setBuziosResult] = useState<{
    abertosCount: number;
    fechadosCount: number;
    odu: {
      numero: number;
      nome: string;
      orixa: string;
      elemento: string;
      tema: string;
    };
    conchas: Array<{ id: number; estado: "aberto" | "fechado" }>;
    interpretation: string;
    creditsLeft: number;
    xpAwarded: number;
  } | null>(null);

  // --- NUMEROLOGY STATE ---
  const [numName, setNumName] = useState(user.birthName || user.name || "");
  const [numBirthDate, setNumBirthDate] = useState(user.birthDate || "");
  const [numLoading, setNumLoading] = useState(false);
  const [numError, setNumError] = useState("");
  const [numResult, setNumResult] = useState<any | null>(null);

  // --- ASTROLOGY STATE ---
  const [astrologyBirthDate, setAstrologyBirthDate] = useState(user.birthDate || "");
  const [astrologyLoading, setAstrologyLoading] = useState(false);
  const [astrologyResult, setAstrologyResult] = useState<any | null>(null);
  const [astrologyError, setAstrologyError] = useState("");

  const storageKey = `exu_pending_oracle_v1:${uid}:${user.id}`;
  const [restored] = useState(() => {
    try {
      if (!uid) return { pending: null as PendingOracle | null, error: "" };
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return { pending: null as PendingOracle | null, error: "" };
      const item = JSON.parse(raw) as PendingOracle;
      if (item.version !== 1 || item.uid !== uid || item.userId !== user.id ||
          !["tarot", "buzios", "numerology", "astrology"].includes(item.kind) ||
          typeof item.key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(item.key) ||
          !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
        throw new Error("Registro inválido");
      }
      if ((item.kind === "tarot" && (typeof item.payload.question !== "string" || ![1, 3].includes(Number(item.payload.slotsCount)))) ||
          (item.kind === "buzios" && typeof item.payload.question !== "string") ||
          (item.kind === "numerology" && (typeof item.payload.birthName !== "string" || typeof item.payload.birthDate !== "string")) ||
          (item.kind === "astrology" && typeof item.payload.birthDate !== "string")) {
        throw new Error("Consulta inválida");
      }
      return { pending: item, error: "" };
    } catch {
      return { pending: null as PendingOracle | null, error: "Não foi possível ler a consulta pendente. Não inicie outra consulta; entre em contato com o suporte para verificar." };
    }
  });
  const [pending, setPending] = useState<PendingOracle | null>(restored.pending);
  const pendingRef = useRef<PendingOracle | null>(restored.pending);
  const [notice, setNotice] = useState(restored.error);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [balanceFresh, setBalanceFresh] = useState(true);
  const balanceFreshRef = useRef(true);
  const aliveRef = useRef(true);
  const userRef = useRef(user);
  userRef.current = user;
  const controllers = useRef(new Set<AbortController>());
  const currentAccount = () => aliveRef.current && Boolean(uid) && auth.currentUser?.uid === uid;
  const formLocked = busy || Boolean(pending) || Boolean(restored.error);
  const paidDisabled = formLocked || !balanceFresh || !uid;

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; controllers.current.forEach(c => c.abort()); };
  }, []);

  useEffect(() => {
    if (restored.pending) setActiveTab(restored.pending.kind);
  }, [restored]);

  function sound(kind: "start" | "done") {
    try { if (kind === "start") AudioEngine.playPortalSwoosh(); else AudioEngine.playCrystalBell(); } catch { /* Áudio não interfere na consulta. */ }
  }

  // Limita também a espera por autenticação, App Check e leitura da resposta.
  async function requestJson(path: string, body?: Record<string, unknown>, key?: string): Promise<{ response: Response; data: any }> {
    const controller = new AbortController();
    controllers.current.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = async () => {
      const account = auth.currentUser;
      if (!account || !currentAccount()) throw new Error("Sua sessão expirou. Entre novamente no portal.");
      const token = await account.getIdToken();
      if (!currentAccount() || controller.signal.aborted) throw new Error("Solicitação interrompida.");
      const response = await apiFetch(path, {
        method: body ? "POST" : "GET", token, signal: controller.signal,
        ...(key ? { idempotencyKey: key } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!data || typeof data !== "object") throw new Error("Resposta inválida do servidor.");
      return { response, data };
    };
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("A confirmação demorou mais que o esperado."));
            controller.abort();
          }, body ? 70_000 : 15_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      controllers.current.delete(controller);
    }
  }

  async function refreshProfile(): Promise<boolean> {
    try {
      const { response, data } = await requestJson("/api/user/profile");
      if (!currentAccount()) return false;
      const fresh = data.user;
      if (!response.ok || !fresh || fresh.id !== userRef.current.id ||
          !Number.isSafeInteger(fresh.credits) || fresh.credits < 0 ||
          !Number.isSafeInteger(fresh.xp) || fresh.xp < 0) throw new Error("Perfil inválido");
      onUpdateUser({ ...userRef.current, ...fresh });
      balanceFreshRef.current = true;
      setBalanceFresh(true);
      return true;
    } catch {
      if (currentAccount()) {
        balanceFreshRef.current = false;
        setBalanceFresh(false);
      }
      return false;
    }
  }

  function savePending(item: PendingOracle) {
    // Sem armazenamento, não enviamos uma cobrança que não poderá ser recuperada.
    sessionStorage.setItem(storageKey, JSON.stringify(item));
    pendingRef.current = item;
    setPending(item);
  }

  function clearPending(): boolean {
    try {
      sessionStorage.removeItem(storageKey);
      pendingRef.current = null;
      setPending(null);
      return true;
    } catch {
      setNotice("Não foi possível atualizar o registro local. Use Verificar consulta pendente antes de iniciar outra consulta.");
      return false;
    }
  }

  function showPaidResult(item: PendingOracle, data: any) {
    if (item.kind === "tarot") {
      if (!Array.isArray(data.drawn) || data.drawn.length !== Number(item.payload.slotsCount) ||
          !data.drawn.every((card: any) => card && typeof card === "object") ||
          typeof data.interpretation !== "string" || !data.interpretation.trim()) throw new Error("Resposta incompleta.");
      setTarotResult({ drawn: data.drawn, interpretation: data.interpretation, xpAwarded: data.alreadyProcessed ? 0 : (data.xpAwarded ?? 0) });
      setFlippedCards(data.drawn.map((_: any, index: number) => index));
    } else if (item.kind === "buzios") {
      const cast = data.castResult;
      if (!cast?.odu || !Array.isArray(cast.conchas) || !cast.conchas.every((shell: any) => shell && typeof shell === "object") ||
          typeof data.interpretation !== "string" || !data.interpretation.trim()) throw new Error("Resposta incompleta.");
      setBuziosResult({ ...cast, interpretation: data.interpretation, creditsLeft: data.creditsLeft, xpAwarded: data.alreadyProcessed ? 0 : (data.xpAwarded ?? 0) });
    } else if (item.kind === "numerology") {
      if (!data.details || typeof data.details.analysis !== "string" || !data.details.analysis.trim()) throw new Error("Resposta incompleta.");
      setNumResult(data.details);
    } else {
      if (!data.details || typeof data.details.analysis !== "string" || !data.details.analysis.trim()) throw new Error("Resposta incompleta.");
      setAstrologyResult(data.details);
    }
    setActiveTab(item.kind);
    sound("done");
  }

  async function runPaid(kind: PaidOracle, payload: Record<string, string | number>, cost: number, recovering = false) {
    if (busyRef.current || restored.error) return;
    const existing = pendingRef.current;
    if (existing && !recovering) {
      setNotice("Existe uma consulta aguardando confirmação. Use Verificar consulta pendente.");
      return;
    }
    if (recovering && !existing) return;
    if (!currentAccount()) { setNotice("Entre novamente no portal para continuar."); return; }
    if (!existing && !balanceFreshRef.current) { setNotice("Atualize seu saldo antes de iniciar outra consulta."); return; }
    if (!existing && userRef.current.credits < cost) { openCreditsMenu(); return; }
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    setBuziosError(""); setNumError("");
    const item: PendingOracle = existing || { version: 1, key: generateIdempotencyKey(), userId: userRef.current.id, uid, kind, payload: { ...payload } };
    const setLoading = item.kind === "tarot" ? setTarotLoading : item.kind === "buzios" ? setBuziosLoading : item.kind === "numerology" ? setNumLoading : setAstrologyLoading;
    setLoading(true);
    let sent = false;
    try {
      if (!existing) savePending(item);
      balanceFreshRef.current = false; setBalanceFresh(false);
      sound("start");
      sent = true;
      const { response, data } = await requestJson(ORACLE_PATHS[item.kind], { ...item.payload, idempotencyKey: item.key }, item.key);
      if (!currentAccount()) return;
      if (!response.ok) {
        const refunded = data.refunded === true || data.code === "KEY_ALREADY_REFUNDED";
        const rejectedBeforeDebit = !existing && [401, 402, 403, 413, 422, 429].includes(response.status);
        if (refunded || rejectedBeforeDebit) {
          const cleared = clearPending();
          const synced = await refreshProfile();
          if (currentAccount() && cleared) setNotice(
            (refunded ? "O servidor confirmou o estorno desta consulta." : String(data.error || "Consulta não autorizada.")) +
            (synced ? "" : " Atualize o saldo para continuar.")
          );
          return;
        }
        throw new Error("A consulta ainda não foi confirmada.");
      }
      showPaidResult(item, data);
      const cleared = clearPending();
      const synced = await refreshProfile();
      if (currentAccount() && cleared) setNotice(synced ? "" : "Sua resposta foi recebida. Atualize o saldo antes da próxima consulta.");
    } catch {
      if (currentAccount()) setNotice(sent
        ? "A confirmação da consulta não chegou. Use Verificar consulta pendente para buscar a mesma leitura. Não é necessário refazer sua pergunta."
        : "Não foi possível salvar a consulta neste navegador. Nenhuma solicitação foi enviada.");
    } finally {
      busyRef.current = false;
      if (currentAccount()) { setBusy(false); setLoading(false); }
    }
  }

  const triggerBuziosLocal = () => runPaid("buzios", { question: buziosQuestion }, ORACLE_COST_AXE);
  const drawTarotCards = () => runPaid("tarot", { question: tarotQuestion, slotsCount: tarotOption }, ORACLE_COST_AXE);
  const calculateNumerologyReport = () => {
    if (!numBirthDate) { setNumError("Por favor, preencha sua data de nascimento."); return; }
    return runPaid("numerology", { birthName: numName, birthDate: numBirthDate }, ORACLE_COST_AXE);
  };
  const recoverPending = () => {
    const item = pendingRef.current;
    if (item) return runPaid(item.kind, item.payload, 0, true);
  };
  const updateBalance = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const synced = await refreshProfile();
      if (currentAccount()) setNotice(synced ? "Saldo atualizado." : "Ainda não foi possível atualizar o saldo. Tente novamente.");
    } finally { busyRef.current = false; if (currentAccount()) setBusy(false); }
  };

  // Mesma protecao de cobranca, recuperacao e idempotencia dos demais oraculos.
  const triggerAstrologyLocal = () => {
    const targetDate = astrologyBirthDate || userRef.current.birthDate;
    if (!targetDate) { setAstrologyError("Por favor, selecione sua data de nascimento."); return; }
    return runPaid("astrology", { birthDate: targetDate }, ORACLE_COST_AXE);
  };
  return (

    
         <div id="oraculos_container" className="grid grid-cols-1 lg:grid-cols-4 gap-6 font-sans">
      {(notice || pending || !balanceFresh) && (
        <div className="col-span-full rounded-xl border border-amber-500/40 bg-zinc-950 p-4 space-y-3" aria-live="polite">
          {notice && <p className="text-sm text-amber-100">{notice}</p>}
          {pending && <div className="space-y-2">
            <p className="text-sm text-amber-100">Consulta pendente: {pending.kind === "tarot" ? "Tarô" : pending.kind === "buzios" ? "Búzios" : "Numerologia"}.</p>
            <button id="recover_oracle_action" onClick={recoverPending} disabled={busy}
              className="rounded-lg bg-amber-400 px-4 py-3 font-bold text-black disabled:opacity-50">
              {busy ? "Aguarde a confirmação..." : "Verificar consulta pendente"}
            </button>
          </div>}
          {!balanceFresh && !pending && <button id="refresh_oracle_balance" onClick={updateBalance} disabled={busy}
            className="rounded-lg border border-amber-400 px-4 py-3 text-amber-200 disabled:opacity-50">Atualizar saldo</button>}
        </div>
      )}

      
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
            id="tab_buzios"
            onClick={() => setActiveTab("buzios")}
            className={`w-full text-left px-4 py-3 rounded-xl border flex items-center gap-3 transition-all cursor-pointer ${
              activeTab === "buzios"
                ? "bg-red-950/40 border-yellow-500/40 text-yellow-400 shadow-[0_4px_15px_rgba(234,179,8,0.1)]"
                : "bg-black/40 border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            <span className="text-sm">🐚</span>
            <div className="text-xs">
              <p className="font-bold tracking-wider">JOGO DE BÚZIOS</p>
              <span className="text-[10px] text-zinc-500 font-mono">16 Conchas de Ifá • 5 Axé</span>
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
              <span className="text-[10px] text-zinc-500 font-mono">Signo & Elemento • 5 Axé</span>
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
                    disabled={formLocked}
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
                      disabled={formLocked}
                      onClick={() => setTarotOption(1)}
                      className={`py-3 px-2 rounded-xl border text-[10.5px] sm:text-xs font-mono font-bold tracking-wider cursor-pointer transition-all ${
                        tarotOption === 1
                          ? "bg-red-950/40 border-yellow-500/50 text-yellow-400"
                          : "bg-black border-red-950/50 text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      1 CARTA (Conselho Rápido • 5 Axé)
                    </button>
                    <button
                      type="button"
                      disabled={formLocked}
                      onClick={() => setTarotOption(3)}
                      className={`py-3 px-2 rounded-xl border text-[10.5px] sm:text-xs font-mono font-bold tracking-wider cursor-pointer transition-all ${
                        tarotOption === 3
                          ? "bg-red-950/40 border-yellow-500/50 text-yellow-400"
                          : "bg-black border-red-950/50 text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      3 CARTAS (Passado/Pres/Fut • 5 Axé)
                    </button>
                  </div>
                </div>
              </div>

              {/* Draw Oraculic action triggers */}
              <div className="flex flex-col items-center">
                <button
                  id="draw_tarot_action"
                  onClick={drawTarotCards}
                  disabled={paidDisabled}
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
                        <div key={`tarot_draw_${card.id || card.nome || idx}_${idx}`} className="w-36 h-56 [perspective:1000px] flex flex-col items-center">
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
                              <span className="text-yellow-400 font-mono text-xs font-bold uppercase">
  ✦ NORMAL
</span>

<div className="text-4xl filter drop-shadow-[0_2px_10px_rgba(234,179,8,0.3)]">
  {card.arcano === "maior" ? "🔮" : "🃏"}
</div>

<div className="text-center">
  <h4 className="text-amber-100 font-bold text-xs tracking-wider line-clamp-2">
    {card.nome || card.name}
  </h4>

  <span className="text-[9px] font-mono text-zinc-500 uppercase">
    {card.arcano === "maior"
      ? "Arcano Maior"
      : `Arcano Menor${card.grupo ? ` • ${card.grupo}` : ""}`}
  </span>
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

          {/* TAB: JOGO DE BÚZIOS (16 CONCHAS DE IFÁ) */}
          {activeTab === "buzios" && (
            <motion.div
              key="oracle_buzios"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="bg-zinc-950/80 border border-red-950/40 p-6 sm:p-8 rounded-3xl backdrop-blur-md space-y-6"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-red-950/50 pb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-widest text-yellow-400 uppercase">
                    Jogo Sagrado dos 16 Búzios de Ifá
                  </h2>
                  <p className="text-xs text-zinc-500">
                    Lançamento real no tabuleiro de palha sagrado com revelação de Odù e interpretação ancestral de Exu
                  </p>
                </div>
                <span className="text-2xl font-mono text-yellow-500">🐚</span>
              </div>

              {/* Consultation Input */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="buzios_focus_input" className="block text-xs font-mono text-zinc-400 uppercase font-semibold">
                    Pergunta ou Foco para os Búzios (Opcional)
                  </label>
                  <input
                    id="buzios_focus_input"
                    disabled={formLocked}
                    type="text"
                    value={buziosQuestion}
                    onChange={(e) => setBuziosQuestion(e.target.value)}
                    placeholder="Ex: Qual Odù rege meus caminhos nesta fase? O que os búzios mostram para minha vida?"
                    className="w-full px-4 py-3 rounded-xl border border-red-950 bg-black text-amber-100 placeholder-zinc-700 text-sm focus:outline-none focus:border-yellow-500/60 transition-all"
                  />
                </div>

                {buziosError && (
                  <div className="text-xs text-red-500 text-center font-mono">
                    ⚠️ {buziosError}
                  </div>
                )}

                {/* Throw Button */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                  <span className="text-xs font-mono text-yellow-500/80">
                    Custo do lançamento: <strong className="text-yellow-400 font-bold">5 Créditos Axé</strong>
                  </span>

                  <button
                    id="launch_buzios_action"
                    onClick={triggerBuziosLocal}
                    disabled={paidDisabled}
                    className="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-amber-400 via-yellow-500 to-amber-600 hover:from-amber-300 hover:to-yellow-400 font-bold tracking-widest text-black text-xs rounded-xl shadow-[0_4px_25px_rgba(234,179,8,0.25)] hover:shadow-yellow-500/40 transition-all cursor-pointer disabled:opacity-50 uppercase flex items-center justify-center gap-2"
                  >
                    {buziosLoading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                        <span>LANÇANDO OS 16 BÚZIOS NO TABULEIRO...</span>
                      </>
                    ) : (
                      <>
                        <span>🐚</span>
                        <span>LANÇAR OS 16 BÚZIOS SAGRADOS</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Buzios Result Display */}
              {buziosResult && (
                <div className="space-y-6 pt-4 border-t border-red-950/30 animate-fade-in">
                  
                  {/* The Altar / Tabuleiro of 16 Shells */}
                  <div className="bg-gradient-to-b from-stone-950 via-zinc-900 to-stone-950 border border-yellow-500/25 p-5 sm:p-7 rounded-2xl text-center shadow-[inset_0_0_40px_rgba(0,0,0,0.8)]">
                    <span className="text-[10px] font-mono tracking-widest text-amber-500 uppercase font-bold block mb-4">
                      TABULEIRO SAGRADO • CAÍDA DAS 16 CONCHAS
                    </span>

                    {/* Shells grid */}
                    <div className="grid grid-cols-4 sm:grid-cols-8 gap-3 sm:gap-4 max-w-2xl mx-auto py-2">
                      {buziosResult.conchas.map((concha, cIdx) => {
                        const isOpen = concha.estado === "aberto";
                        return (
                          <div
                            key={`buzios_shell_${concha.id || cIdx}_${cIdx}`}
                            className={`flex flex-col items-center justify-center p-2.5 rounded-xl border transition-all ${
                              isOpen
                                ? "bg-amber-950/40 border-yellow-500/60 shadow-[0_0_15px_rgba(234,179,8,0.25)]"
                                : "bg-black/60 border-zinc-800 text-zinc-600 opacity-60"
                            }`}
                          >
                            <span className="text-2xl sm:text-3xl filter drop-shadow">
                              {isOpen ? "🐚" : "🌑"}
                            </span>
                            <span className={`text-[8.5px] font-mono mt-1 font-bold uppercase ${
                              isOpen ? "text-yellow-400" : "text-zinc-500"
                            }`}>
                              {isOpen ? "Aberto" : "Fechado"}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Counts tally */}
                    <div className="flex justify-center gap-6 mt-4 pt-3 border-t border-zinc-800/60 text-xs font-mono">
                      <span className="text-yellow-400 font-bold">
                        ✦ {buziosResult.abertosCount} Búzios Abertos (Luz)
                      </span>
                      <span className="text-zinc-400">
                        • {buziosResult.fechadosCount} Búzios Fechados (Sombra)
                      </span>
                    </div>
                  </div>

                  {/* Odù Revealed Banner */}
                  <div className="bg-gradient-to-r from-red-950/60 via-zinc-900 to-amber-950/40 border border-yellow-500/40 p-5 rounded-2xl">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                      <div>
                        <span className="text-[10px] font-mono text-yellow-500 uppercase font-black tracking-widest block">
                          ODÙ REVELADO NA CAÍDA (Nº {buziosResult.odu.numero})
                        </span>
                        <h3 className="text-xl sm:text-2xl font-black text-amber-200 uppercase tracking-wider font-mono">
                          {buziosResult.odu.nome}
                        </h3>
                      </div>
                      <div className="flex gap-2">
                        <span className="px-3 py-1 bg-black/60 rounded-lg border border-yellow-500/30 text-yellow-400 text-xs font-mono font-bold">
                          Orixá: {buziosResult.odu.orixa}
                        </span>
                        <span className="px-3 py-1 bg-black/60 rounded-lg border border-red-500/30 text-red-400 text-xs font-mono font-bold">
                          Elemento: {buziosResult.odu.elemento}
                        </span>
                      </div>
                    </div>

                    <div className="pt-3 text-xs sm:text-sm text-zinc-300 font-sans leading-relaxed">
                      <strong className="text-yellow-400 font-mono text-xs uppercase block mb-1">
                        Princípio Ancestral do Odù:
                      </strong>
                      <p>{buziosResult.odu.tema}</p>
                    </div>
                  </div>

                  {/* Interpretation by Exu */}
                  <div className="bg-black/60 border border-red-950/40 p-5 rounded-2xl select-text">
                    <p className="text-[10px] font-mono tracking-widest text-yellow-500 uppercase font-bold mb-2">
                      LEITURA E ORIENTAÇÃO ESPIRITUAL DE EXU PELOS BÚZIOS:
                    </p>
                    <div className="text-sm text-zinc-300 leading-relaxed space-y-3 whitespace-pre-wrap selection:bg-red-900 select-text">
                      {buziosResult.interpretation}
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
                    disabled={formLocked}
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
                    disabled={formLocked}
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
                  disabled={paidDisabled}
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
                      <span>GERAR MAPA CABALÍSTICO (5 Axé)</span>
                    </>
                  )}
                </button>
              </div>

              {numError && (
                <div className="p-3 bg-red-950/40 border border-red-900/50 rounded-xl text-red-400 text-xs font-mono text-center">
                  ⚠️ {numError}
                </div>
              )}

              {/* Numerology detailed report result */}
              {numResult && (
                <div className="space-y-6 pt-4 border-t border-red-950/30 animate-fade-in">
                  
                  {/* Grid showing computed numbers */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-2">
                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Caminho do Destino</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.destinyNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">
Missão desta encarnação
</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Número de Alma</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.soulNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">
O que sua alma busca
</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Número de Expressão</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.expressionNumber}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">
Forças naturais
</small>
                    </div>

                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 rounded-xl border border-yellow-500/10 text-center flex flex-col justify-center items-center shadow-md">
                      <span className="text-[9px] font-mono text-yellow-600 uppercase font-semibold tracking-wider">Ano Pessoal</span>
                      <span className="text-3xl font-extrabold text-yellow-400 font-mono my-1.5">{numResult.personalYear}</span>
                      <small className="text-[9px] text-zinc-500 font-mono">
Energia do ano atual
</small>
                    </div>
                  </div>

                  {/* Interpretive text section */}
                  <div className="bg-black/60 border border-red-950/40 p-5 rounded-2xl select-text">
                    <p className="text-[10px] font-mono tracking-widest text-yellow-500 uppercase font-bold mb-2">LEITURA NUMEROLÓGICA DOS CAMINHOS:</p>
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
                  <p className="text-xs text-zinc-500">Sincronize a órbita de sua vida com o seu elemento natural protetor - custo de 5 créditos Axé</p>
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
                    disabled={paidDisabled}
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