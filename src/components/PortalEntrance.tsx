/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, CheckCircle, Compass, LogIn, Volume2, VolumeX, Flame, User, Mail, Calendar, Clock, MapPin, Lock, Eye, EyeOff } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile } from "../types";

interface PortalEntranceProps {
  onLoginSuccess: (user: UserProfile) => void;
}

export default function PortalEntrance({ onLoginSuccess }: PortalEntranceProps) {
  const [viewState, setViewState] = useState<"splash" | "register" | "verify" | "login">("splash");
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // Sync mute/play status without reloading video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = !soundEnabled;
      if (soundEnabled) {
        videoRef.current.play().catch((err) => {
          console.warn("Autoplay unmute play retry:", err);
        });
      }
    }
  }, [soundEnabled]);

  // Form states
  const [birthName, setBirthName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [birthTime, setBirthTime] = useState("");
  const [birthPlace, setBirthPlace] = useState("Não informada");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Anti-abuse security & verification states
  const [honeypot, setHoneypot] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [generatedCode, setGeneratedCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [sessionSign, setSessionSign] = useState("");

  // Generate device Fingerprint tracking
  const getDeviceFingerprint = () => {
    let devId = localStorage.getItem("exu_device_id");
    if (!devId) {
      devId = "dev_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now().toString().slice(-4);
      localStorage.setItem("exu_device_id", devId);
    }
    return devId;
  };

  useEffect(() => {
    setSessionSign("sess_" + Math.random().toString(36).substring(2, 11));
  }, []);

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

  // Cleanup drone on unmount
  useEffect(() => {
    return () => {
      AudioEngine.stopDrone();
    };
  }, []);

  // First step of registration: Anti-bot checks and trigger Verification code
  const handleInitiateRegister = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (honeypot) {
      setError("Atividade suspeita bloqueada.");
      return;
    }

    if (!birthName || !birthDate || !email || !password) {
      setError("Todos os campos de cadastro são obrigatórios para traçar os caminhos cósmicos.");
      return;
    }

    // Mathematical Captcha verification checks
    if (!captchaAnswer || parseInt(captchaAnswer) !== 7) {
      setError("A resposta do desafio antibot está incorreta. Quanto é 4 + 3?");
      return;
    }

    // Generate random 4-digit code for mock confirmation
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setGeneratedCode(code);
    setViewState("verify");
    AudioEngine.playCrystalBell();
  };

  // Second step: Real backend submit with device metadata & IP tracker logs
  const handleExecuteFinalRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!inputCode) {
      setError("Digite o código de verificação recebido em seu e-mail.");
      return;
    }

    if (inputCode !== generatedCode) {
      setError("Código de verificação incorreto. Verifique a caixa ou use o simulador místico.");
      return;
    }

    setLoading(true);

    if (soundEnabled) {
      AudioEngine.playPortalSwoosh();
      AudioEngine.playThunderStrike();
    }

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          birthName,
          birthDate,
          birthTime,
          birthPlace,
          email,
          password,
          deviceId: getDeviceFingerprint(),
          browser: navigator.userAgent,
          session: sessionSign,
          captchaAnswer,
          honeypot
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Mistério espiritual no cadastro. Revise as correntes.");
      }

      setTimeout(() => {
        onLoginSuccess(data.user);
        setLoading(false);
      }, 1500);

    } catch (err: any) {
      setError(err.message || "Tentativa de cadastro falhou. Tente novamente.");
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Insira seu e-mail e sua senha de acesso.");
      return;
    }

    setLoading(true);

    if (soundEnabled) {
      AudioEngine.playPortalSwoosh();
      AudioEngine.playCrystalBell();
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "E-mail ou senha incorretos.");
      }

      setTimeout(() => {
        onLoginSuccess(data.user);
        setLoading(false);
      }, 1200);

    } catch (err: any) {
      setError(err.message || "Erro de conexão astral.");
      setLoading(false);
    }
  };

  return (
    <div id="portal_view" className="relative w-full min-h-[90vh] lg:min-h-0 bg-black lg:bg-zinc-950/95 border-0 lg:border lg:border-yellow-500/20 rounded-none lg:rounded-3xl overflow-hidden flex flex-col items-center justify-center font-sans px-4 sm:px-10 py-10 select-none shadow-none lg:shadow-[0_25px_60px_rgba(0,0,0,0.95)]">
      
      {/* Immersive Full Screen Background Video */}
      <div className="absolute inset-0 z-0 overflow-hidden select-none pointer-events-none bg-zinc-950 bg-[radial-gradient(circle_at_center,rgba(115,10,10,0.45)_0%,rgba(0,0,0,1)_100%)] animate-pulse duration-[10000ms]">
        <video
          ref={videoRef}
          id="main_portal_bg_video"
          src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/Exu-Responde.mp4"
          className="w-full h-full object-cover filter brightness-[0.5] contrast-[1.12]"
          autoPlay
          loop
          muted={!soundEnabled}
          playsInline
          referrerPolicy="no-referrer"
        />
        {/* Cinematic dark/red mask gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/85 z-1" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(115,10,10,0.25)_0%,transparent_100%)] z-1" />
      </div>

      {/* Volumetric Smoke Particles Sim */}
      <div className="absolute inset-0 pointer-events-none z-1 mix-blend-screen opacity-20">
        <div className="absolute -top-[10%] left-[20%] w-[60%] h-[50%] rounded-full bg-red-950/25 blur-[130px] animate-pulse" />
        <div className="absolute -bottom-[10%] right-[10%] w-[50%] h-[60%] rounded-full bg-amber-950/20 blur-[120px] animate-pulse duration-[8000ms]" />
      </div>

      {/* Main Container */}
      <div className="w-full max-w-lg flex flex-col items-center z-10 text-center space-y-6">
        
        <AnimatePresence mode="wait">
          {viewState === "splash" ? (
            /* ========================================================= */
            /* SPLASH VIEW - IMMERSIVE CINEMATIC INTRODUCTION            */
            /* ========================================================= */
            <motion.div
              key="splash_view"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: -40 }}
              transition={{ duration: 0.8 }}
              className="flex flex-col items-center space-y-8"
            >
              {/* Branding Titles */}
              <div className="text-center">
                <span className="text-[11px] font-mono tracking-[0.45em] text-red-500 uppercase font-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
                  Conselho Estratégico & Sabedoria Ancestral
                </span>
                <h1 
                  className="text-5xl sm:text-6xl font-black tracking-[0.25em] text-transparent bg-clip-text bg-gradient-to-b from-yellow-200 via-amber-400 to-amber-700 uppercase mt-4 select-none"
                  style={{ textShadow: "0 0 25px rgba(245, 158, 11, 0.5), 0 5px 12px rgba(0,0,0,0.9)" }}
                >
                  EXU RESPONDE
                </h1>
                <p className="text-zinc-300 text-sm italic font-medium tracking-wide max-w-md mt-3 drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] leading-relaxed">
                  "Ele não julga quem errou ou acertou. Ele abre caminhos para quem tem coragem de questionar e estratégia para caminhar."
                </p>
              </div>

              {/* STUNNING REPRESENTATION OF EXU AVATAR */}
              <div className="relative my-4 flex items-center justify-center">
                {/* Glowing cosmic background rings */}
                <div className="absolute w-44 h-44 rounded-full bg-gradient-to-tr from-red-600 via-amber-600 to-yellow-500 opacity-20 blur-[30px] animate-pulse" />
                <div className="absolute w-36 h-36 border border-yellow-500/10 rounded-full animate-spin duration-[15s]" />
                <div className="absolute w-40 h-40 border border-red-500/10 rounded-full animate-reverse duration-[20s]" />
                
                {/* Outer metallic carbon ring */}
                <div className="relative w-32 h-32 rounded-full bg-gradient-to-b from-zinc-900 to-zinc-950 p-[3px] border border-yellow-500/30 flex items-center justify-center shadow-[0_0_50px_rgba(185,28,28,0.4)] transition-all">
                  
                  {/* Inside Gold/Black Mirror Screen */}
                  <div className="w-full h-full rounded-full bg-black flex flex-col items-center justify-center overflow-hidden relative">
                    
                    {/* Exu Responde Avatar Picture */}
                    <img 
                      src="https://portalvipbrasil.com.br/wp-content/uploads/2026/05/ChatGPT-Image-29-de-mai.-de-2026-09_27_07.png" 
                      alt="Exu Responde" 
                      className="w-full h-full object-cover z-10"
                      referrerPolicy="no-referrer"
                    />

                    {/* Dark smoke glow overlay */}
                    <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-red-950/60 to-transparent z-20 pointer-events-none" />
                  </div>
                </div>

                {/* Satellite aura particles */}
                <div className="absolute w-2.5 h-2.5 bg-yellow-400 rounded-full filter blur-[1px] animate-bounce" style={{ top: "10%", right: "12%" }} />
                <div className="absolute w-1.5 h-1.5 bg-red-600 rounded-full filter blur-[1px] animate-pulse" style={{ bottom: "16%", left: "10%" }} />
              </div>

              {/* Main Initiation Button with immersive particle ripples */}
              <motion.button
                id="entrar_caminhos_btn"
                type="button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setViewState("register");
                  if (soundEnabled) {
                    AudioEngine.playCrystalBell();
                  }
                }}
                className="group relative flex items-center justify-center gap-4 px-12 py-5 font-black text-xs tracking-[0.25em] text-black bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-200 hover:to-amber-500 rounded-full shadow-[0_0_35px_rgba(245,158,11,0.45)] cursor-pointer overflow-hidden transition-all duration-300"
              >
                {/* Internal slide gloss decoration */}
                <div className="absolute inset-0 w-1/2 h-full bg-white/20 transform -skew-x-[25deg] -translate-x-full group-hover:translate-x-[300%] transition-transform duration-1000" />
                <span className="relative z-10 font-bold">CADASTRAR-SE AGORA 🔱</span>
                {/* Red pulse border */}
                <div className="absolute inset-x-0 bottom-0 h-1 bg-red-600 animate-pulse" />
              </motion.button>

              {/* Quick links header */}
              <div className="flex gap-4 items-center justify-center pt-2">
                <button
                  onClick={() => setViewState("login")}
                  className="text-xs font-mono font-bold tracking-widest text-yellow-500 hover:text-yellow-400 underline transition cursor-pointer"
                >
                  MINHA CONTA
                </button>
              </div>

              {/* Disclaimer */}
              <p className="text-[10px] text-zinc-500 max-w-xs leading-relaxed uppercase tracking-wider font-mono">
                Portal místico de sabedoria ancestral, numerologia sagrada & Ifá diaspórico.
              </p>
            </motion.div>
          ) : viewState === "register" ? (
            /* ========================================================= */
            /* MANDATORY DETAILED REGISTRATION CARD                      */
            /* ========================================================= */
            <motion.div
              key="register_view"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.6 }}
              className="w-full relative mt-2 bg-black/55 border border-yellow-500/25 p-6 sm:p-8 rounded-3xl shadow-[0_25px_60px_rgba(0,0,0,0.98)] backdrop-blur-md transition-all duration-500"
            >
              {/* Corner Symbols */}
              <div className="absolute top-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute top-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>

              <div className="text-center mb-6">
                <h2 className="text-xl font-extrabold uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-amber-500">
                  Cadastrar Identidade Sagrada
                </h2>
                <p className="text-xs text-zinc-400 mt-1 font-mono">
                  Inscreva-se para obter seu perfil espiritual, mapa vibracional e Odu.
                </p>
              </div>

              {error && (
                <div className="mb-4 text-red-500 text-xs font-mono bg-red-950/60 py-2.5 px-4 border border-red-900/60 rounded-xl text-center">
                  ⚠️ {error}
                </div>
              )}

              <form onSubmit={handleInitiateRegister} className="space-y-4 text-left">
                {/* Nome completo de solteiro */}
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    <User className="w-3 h-3 text-red-500" /> Nome Completo de Solteiro
                  </label>
                  <input
                    type="text"
                    required
                    value={birthName}
                    disabled={loading}
                    onChange={(e) => setBirthName(e.target.value)}
                    placeholder="Seu nome sem alterações de casamento"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 placeholder-zinc-600 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                  />
                </div>

                {/* Birthday Grid row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Data de nascimento */}
                  <div>
                    <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                      <Calendar className="w-3 h-3 text-red-500" /> Data de Nascimento
                    </label>
                    <input
                      type="date"
                      required
                      value={birthDate}
                      disabled={loading}
                      onChange={(e) => setBirthDate(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                    />
                  </div>

                  {/* Horário de nascimento */}
                  <div>
                    <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-zinc-500" /> Hora de seu nascimento (Opcional)
                    </label>
                    <input
                      type="time"
                      value={birthTime}
                      disabled={loading}
                      onChange={(e) => setBirthTime(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    <Mail className="w-3 h-3 text-red-500" /> E-mail de Contato
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    disabled={loading}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="seu.email@exemplo.com"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 placeholder-zinc-600 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                  />
                </div>

                {/* Senha */}
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    <Lock className="w-3 h-3 text-red-500" /> Senha Segura
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      value={password}
                      disabled={loading}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Crie sua senha sagrada"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3.5 top-3 text-zinc-500 hover:text-zinc-300"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Invisible Honeypot anti-spam protection */}
                <div className="hidden absolute left-[-9999px] top-[-9999px] h-0 w-0 opacity-0 overflow-hidden" aria-hidden="true">
                  <input
                    type="text"
                    name="honeypot"
                    value={honeypot}
                    onChange={(e) => setHoneypot(e.target.value)}
                    tabIndex={-1}
                    autoComplete="off"
                  />
                </div>

                {/* Interactive Mathematical Anti-bot Captcha */}
                <div className="mt-4 p-3 bg-red-950/20 rounded-xl border border-red-950/45 text-left">
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    🛡️ Desafio de Segurança (Anti-robô)
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-mono text-zinc-400">Quanto é 4 + 3?</span>
                    <input
                      type="text"
                      required
                      maxLength={2}
                      value={captchaAnswer}
                      disabled={loading}
                      onChange={(e) => setCaptchaAnswer(e.target.value)}
                      placeholder="?"
                      className="w-16 px-2 py-1.5 rounded border border-zinc-850 bg-black text-center text-xs font-bold font-mono text-yellow-500 focus:outline-none focus:border-yellow-500"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full relative flex items-center justify-center gap-3 py-4 mt-2 font-extrabold tracking-[0.2em] text-black bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-250 hover:to-amber-500 rounded-xl shadow-[0_4px_30px_rgba(234,179,8,0.35)] active:scale-[0.98] transition-all duration-300 cursor-pointer disabled:opacity-50 overflow-hidden"
                >
                  <Sparkles className="w-4 h-4 text-black stroke-[2.5]" />
                  <span className="text-xs uppercase">TRAÇAR MEUS CAMINHOS 🔱</span>
                  <div className="absolute inset-x-0 bottom-0 h-[2px] bg-red-600 animate-pulse" />
                </button>
              </form>

              <div className="mt-5 text-center pt-3 border-t border-zinc-900">
                <button
                  onClick={() => setViewState("login")}
                  className="text-xs font-mono text-zinc-400 hover:text-yellow-500 transition cursor-pointer"
                >
                  Já tem uma conta? <span className="underline font-bold text-yellow-500">Conecte-se</span>
                </button>
              </div>
            </motion.div>
          ) : viewState === "verify" ? (
            /* ========================================================= */
            /* INTERACTIVE EMAIL VERIFICATION CARD                       */
            /* ========================================================= */
            <motion.div
              key="verify_view"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.6 }}
              className="w-full relative mt-2 bg-black/55 border border-yellow-500/25 p-6 sm:p-8 rounded-3xl shadow-[0_25px_60px_rgba(0,0,0,0.98)] backdrop-blur-md transition-all duration-500"
            >
              {/* Corner Symbols */}
              <div className="absolute top-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute top-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>

              <div className="text-center mb-6">
                <h2 className="text-xl font-extrabold uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-amber-500">
                  Verificação de E-mail
                </h2>
                <p className="text-xs text-zinc-400 mt-1 font-mono">
                  Ativação segura e anti-fraude de novo buscador.
                </p>
              </div>

              {/* Simulated Mailbox Alert Box mockup */}
              <div className="mb-4 bg-amber-950/45 border border-amber-500/35 p-3.5 rounded-xl text-left">
                <div className="flex items-center gap-2 text-yellow-500 text-xs font-mono font-bold uppercase mb-1">
                  <Mail className="w-4 h-4" /> 📥 [NOTIFICAÇÃO VIRTUAL]
                </div>
                <p className="text-[11px] text-zinc-300 font-mono leading-relaxed">
                  Enviamos um e-mail com o código de confirmação ancestral para <span className="text-yellow-400 underline font-semibold">{email}</span>. Use o código temporário abaixo para validar:
                </p>
                <div className="mt-2 text-center bg-black/80 py-2 border border-yellow-500/20 rounded-lg text-lg font-bold font-mono tracking-widest text-yellow-400 select-all">
                  {generatedCode}
                </div>
              </div>

              {error && (
                <div className="mb-4 text-red-500 text-xs font-mono bg-red-950/60 py-2.5 px-4 border border-red-900/60 rounded-xl text-center">
                  ⚠️ {error}
                </div>
              )}

              <form onSubmit={handleExecuteFinalRegister} className="space-y-4 text-left">
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    Chave de Ativação (4 Dígitos)
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={4}
                    value={inputCode}
                    disabled={loading}
                    onChange={(e) => setInputCode(e.target.value)}
                    placeholder="Digite os 4 dígitos"
                    className="w-full text-center tracking-[0.3em] px-3.5 py-3 rounded-lg border border-zinc-800 bg-black/70 text-yellow-300 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-lg font-extrabold"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full relative flex items-center justify-center gap-3 py-4 mt-2 font-extrabold tracking-[0.2em] text-black bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-250 hover:to-amber-500 rounded-xl shadow-[0_4px_30px_rgba(234,179,8,0.35)] active:scale-[0.98] transition-all duration-300 cursor-pointer disabled:opacity-50 overflow-hidden"
                >
                  {loading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs">CRUZANDO CORRENTES...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4 text-black stroke-[2.5]" />
                      <span className="text-xs uppercase">ATIVAR MINHA CONTA</span>
                    </>
                  )}
                  <div className="absolute inset-x-0 bottom-0 h-[2px] bg-red-600 animate-pulse" />
                </button>
              </form>

              <div className="mt-5 text-center pt-3 border-t border-zinc-900 flex flex-col gap-2">
                <button
                  onClick={() => setViewState("register")}
                  className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                >
                  ← Voltar e Corrigir Cadastro
                </button>
              </div>
            </motion.div>
          ) : (
            /* ========================================================= */
            /* RETURNING USER LOGIN CARD                                 */
            /* ========================================================= */
            <motion.div
              key="login_view"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.6 }}
              className="w-full relative mt-2 bg-black/55 border border-yellow-500/25 p-6 sm:p-8 rounded-3xl shadow-[0_25px_60px_rgba(0,0,0,0.98)] backdrop-blur-md transition-all duration-500"
            >
              {/* Corner Symbols */}
              <div className="absolute top-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute top-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 left-4 text-xs text-yellow-500/70 font-bold">🔱</div>
              <div className="absolute bottom-4 right-4 text-xs text-yellow-500/70 font-bold">🔱</div>

              <div className="text-center mb-6">
                <h2 className="text-xl font-extrabold uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-amber-500">
                  Minha Conta
                </h2>
                <p className="text-xs text-zinc-400 mt-1 font-mono">
                  Identifique suas correntes para entrar em seu painel espiritual.
                </p>
              </div>

              {error && (
                <div className="mb-4 text-red-500 text-xs font-mono bg-red-950/60 py-2.5 px-4 border border-red-900/60 rounded-xl text-center">
                  ⚠️ {error}
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4 text-left">
                {/* Email */}
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    <Mail className="w-3 h-3 text-red-500" /> E-mail Registrado
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    disabled={loading}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="seu.email@exemplo.com"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 placeholder-zinc-650 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                  />
                </div>

                {/* Senha */}
                <div>
                  <label className="block text-[10px] font-mono font-bold tracking-widest text-zinc-300 uppercase mb-1.5 flex items-center gap-1.5">
                    <Lock className="w-3 h-3 text-red-500" /> Senha Espiritual
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      value={password}
                      disabled={loading}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Sua senha de segurança"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-black/70 text-amber-100 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/70 transition-all font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3.5 top-3 text-zinc-500 hover:text-zinc-300"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full relative flex items-center justify-center gap-3 py-4 mt-2 font-extrabold tracking-[0.2em] text-black bg-gradient-to-r from-yellow-300 via-amber-400 to-amber-600 hover:from-yellow-250 hover:to-amber-500 rounded-xl shadow-[0_4px_30px_rgba(234,179,8,0.35)] active:scale-[0.98] transition-all duration-300 cursor-pointer disabled:opacity-50 overflow-hidden"
                >
                  {loading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs">CONECTANDO AO ORÁCULO...</span>
                    </>
                  ) : (
                    <>
                      <LogIn className="w-4 h-4 text-black stroke-[2.5]" />
                      <span className="text-xs uppercase">ENTRAR NO PORTAL</span>
                    </>
                  )}
                  <div className="absolute inset-x-0 bottom-0 h-[2px] bg-red-600 animate-pulse" />
                </button>
              </form>

              <div className="mt-5 text-center pt-3 border-t border-zinc-900 flex flex-col gap-2">
                <button
                  onClick={() => setViewState("register")}
                  className="text-xs font-mono text-zinc-400 hover:text-yellow-500 transition cursor-pointer"
                >
                  Novo peregrino? <span className="underline font-bold text-yellow-500">Faça o Cadastro Obrigatório</span>
                </button>
                <button
                  onClick={() => setViewState("splash")}
                  className="text-[10px] font-mono text-zinc-650 hover:text-zinc-400 transition cursor-pointer font-bold mt-2"
                >
                  ← Voltar para a Tela Principal
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Traditional Ethos Disclosure */}
        <div className="mt-4 text-[10px] text-zinc-400 space-y-2 leading-relaxed max-w-sm px-4 bg-black/40 p-3 rounded-2xl backdrop-blur-md border border-zinc-900/60 uppercase font-mono tracking-wider">
          <p className="text-zinc-500">
            O oráculo de Exu oferece leituras simbólicas ancestrais voltadas ao autoconhecimento, à cultura afro-diaspórica e espiritualidade.
          </p>
          <div className="flex justify-center gap-4 text-[9px] text-zinc-500">
            <span>🛡️ SEGURO</span>
            <span>✨ ANCESTRAL</span>
            <span>⚖️ EQUILIBRADO</span>
          </div>
        </div>

      </div>
    </div>
  );
}
