/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { motion } from "motion/react";
import { Award, Compass, Gift, Clock, ShieldCheck, Flame, Compass as ArIcon, Heart as AguaIcon, ShieldAlert } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile } from "../types";
import { auth } from "../firebase";

interface UserProfileProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
}

const LEVEL_THRESHOLDS: Record<string, number> = {
  "Buscador": 200,
  "Aprendiz": 500,
  "Peregrino": 1200,
  "Iniciado": 2500,
  "Guardião": 5000,
  "Conhecedor": 8000,
  "Mestre dos Caminhos": 99999
};

const MILESTONES_DATA = [
  { id: "m_1", title: "Iniciação Sutil", desc: "Abriu as cortinas do portal Exu Responde.", xp: 50, req: 0 },
  { id: "m_2", title: "Primeiro Cruzamento", desc: "Realizou sua consulta inicial ao terreiro virtual.", xp: 100, req: 15 },
  { id: "m_3", title: "Cabalista de Ifá", desc: "Calculou seu mapa de destino natalicio completo.", xp: 150, req: 100 },
  { id: "m_4", title: "Guardião dos Mistérios", desc: "Subiu além do nível Iniciado de sabedoria.", xp: 300, req: 1200 }
];

export default function UserProfilePanel({ user, onUpdateUser }: UserProfileProps) {
  // Birth settings form
  const [editName, setEditName] = useState(user.name || "");
  const [birthName, setBirthName] = useState(user.birthName || "");
  const [birthDate, setBirthDate] = useState(user.birthDate || "");
  const [birthTime, setBirthTime] = useState(user.birthTime || "");
  const [birthPlace, setBirthPlace] = useState(user.birthPlace || "");
  const [updating, setUpdating] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const maxThreshold = LEVEL_THRESHOLDS[user.level] || 1000;
  // Calculate relative progress inside current level category
  const getPrevThreshold = () => {
    const keys = Object.keys(LEVEL_THRESHOLDS);
    const index = keys.indexOf(user.level);
    if (index <= 0) return 0;
    return LEVEL_THRESHOLDS[keys[index - 1]];
  };

  const prevVal = getPrevThreshold();
  const xpInCurrentLevel = user.xp - prevVal;
  const levelXpRange = maxThreshold - prevVal;
  const rawPct = (xpInCurrentLevel / levelXpRange) * 100;
  const levelPct = Math.min(Math.max(rawPct, 5), 100);

  const saveProfileData = async (e: React.FormEvent) => {
    e.preventDefault();
    setUpdating(true);
    setSuccessMsg("");
    AudioEngine.playCrystalBell();

    try {
      const firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        throw new Error(
          "Sua sessão expirou. Entre novamente para atualizar o perfil."
        );
      }

      const token = await firebaseUser.getIdToken();

      const res = await fetch("/api/user/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name: editName,
          birthName,
          birthDate,
          birthTime,
          birthPlace
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ocorreu uma falha.");
      onUpdateUser(data.user);
      setSuccessMsg("Seu perfil astral e de identidade foi re-gravado nas águas sagradas!");
      setTimeout(() => setSuccessMsg(""), 4000);
    } catch (err: any) {
      alert(err.message || "Falha.");
    } finally {
      setUpdating(false);
    }
  };

  // Generate dynamic values for elemental balancing charts based on registry data
  const elements = [
    { name: "Fogo (Ação/Atitude)", value: user.xp > 300 ? 85 : 50, icon: <Flame className="w-4 h-4 text-orange-500 animate-pulse" /> },
    { name: "Ar (Mente/Estratégia)", value: user.birthName ? 90 : 45, icon: <ArIcon className="w-4 h-4 text-yellow-400" /> },
    { name: "Terra (Prosperidade/Bases)", value: user.credits > 30 ? 75 : 40, icon: <Compass className="w-4 h-4 text-emerald-500" /> },
    { name: "Água (Intuição/Espírito)", value: user.birthDate ? 80 : 35, icon: <AguaIcon className="w-4 h-4 text-sky-400" /> }
  ];

  return (
    <div id="seeker_profile_section" className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-sans select-none">
      
      {/* Left Column: Level, Achievements, Elements */}
      <div className="lg:col-span-2 space-y-6">
        
        {/* Level and XP Evolutionary Board */}
        <div className="bg-zinc-950/80 border border-red-950/40 p-6 rounded-3xl backdrop-blur-md relative overflow-hidden">
          
          <div className="absolute top-0 right-0 w-32 h-32 bg-red-900/10 rounded-full blur-3xl pointer-events-none" />

          <div className="flex items-center gap-4 mb-4 select-none">
            <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-yellow-600 via-yellow-400 to-amber-700 p-0.5 flex items-center justify-center shadow-[0_4px_15px_rgba(234,179,8,0.25)]">
              <div className="w-full h-full rounded-full bg-zinc-950 flex flex-col items-center justify-center font-mono">
                <span className="text-xl">🌟</span>
              </div>
            </div>
            
            <div>
              <span className="text-[10px] font-mono tracking-widest text-red-500 font-bold uppercase">Patamar de Sabedoria</span>
              <h2 className="text-xl font-black text-amber-100 tracking-wider uppercase mt-0.5">{user.level}</h2>
              <p className="text-xs text-zinc-400 font-mono tracking-wide mt-1">ACÚMULO DE ENERGIA: <strong className="text-yellow-400">{user.xp} XP</strong></p>
            </div>
          </div>

          {/* Progress Bar of Evolution */}
          <div className="space-y-1.5 select-none">
            <div className="flex justify-between text-[10px] font-mono text-zinc-500">
              <span className="uppercase">Progresso da Coroa</span>
              <span>{user.xp} / {maxThreshold} XP</span>
            </div>
            
            <div className="w-full bg-black h-3 rounded-full border border-red-950/40 overflow-hidden p-0.5 shadow-inner">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${levelPct}%` }}
                transition={{ duration: 1.5 }}
                className="h-full bg-gradient-to-r from-red-600 via-yellow-500 to-amber-500 rounded-full shadow-[0_0_8px_rgba(217,119,6,0.5)]"
              />
            </div>

            <div className="flex justify-between text-[9px] font-mono text-zinc-600">
              <span>{prevVal} XP</span>
              <span className="uppercase text-yellow-500/80 font-semibold">PRÓXIMO PATAMAR: {maxThreshold} XP</span>
            </div>
          </div>
        </div>

        {/* Tactical Elemental Balancing Grid */}
        <div className="bg-zinc-950/80 border border-red-950/40 p-6 rounded-3xl backdrop-blur-md">
          <h3 className="text-xs font-mono font-bold tracking-widest text-yellow-500 uppercase mb-4">Equilíbrio Elementar Corrente</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {elements.map((el, i) => (
              <div key={i} className="bg-zinc-900/50 border border-zinc-900/80 p-4 rounded-xl space-y-2">
                <div className="flex items-center gap-2 justify-between">
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    {el.icon}
                    <span className="font-medium">{el.name}</span>
                  </div>
                  <span className="text-xs font-mono font-bold text-yellow-400">{el.value}%</span>
                </div>
                {/* Horizontal element progress bar */}
                <div className="w-full h-1.5 bg-black rounded-lg overflow-hidden">
                  <div className="h-full bg-yellow-500 rounded-lg" style={{ width: `${el.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Achievements list */}
        <div className="bg-zinc-950/80 border border-red-950/40 p-6 rounded-3xl backdrop-blur-md">
          <h3 className="text-xs font-mono font-bold tracking-widest text-yellow-500 uppercase mb-4">Conquistas de Luz Astral</h3>
          
          <div className="space-y-3.5 select-none">
            {MILESTONES_DATA.map((item) => {
              const attained = user.xp >= item.req;
              
              return (
                <div
                  key={item.id}
                  className={`border p-4 rounded-xl flex items-center justify-between gap-4 transition-all duration-300 ${
                    attained
                      ? "bg-red-950/15 border-yellow-500/20"
                      : "bg-black/30 border-dashed border-red-950/30 opacity-40 select-none pointer-events-none"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border text-base shadow-sm ${
                      attained ? 'bg-black border-yellow-500/40 text-yellow-400' : 'bg-zinc-900 border-zinc-800 text-zinc-600'
                    }`}>
                      {attained ? "⚜️" : "🔒"}
                    </div>
                    <div>
                      <h4 className="text-amber-100 font-bold text-xs tracking-wider uppercase">{item.title}</h4>
                      <p className="text-[11px] text-zinc-400 mt-0.5 leading-normal">{item.desc}</p>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-[9px] font-mono px-2 py-1 rounded bg-black/80 border border-yellow-500/20 text-yellow-400 uppercase font-bold">
                      +{item.xp} XP
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* Right Column: Profile details form update */}
      <div className="lg:col-span-1">
        <div className="bg-zinc-950/80 border border-red-950/40 p-6 rounded-3xl backdrop-blur-md relative">
          
          <h3 className="text-xs font-mono font-bold tracking-widest text-yellow-500 uppercase mb-4 border-b border-red-950/30 pb-2">Identidade Cósmica</h3>

          <form onSubmit={saveProfileData} className="space-y-4 font-mono text-xs text-left">
            
            <div className="space-y-1.5">
              <label htmlFor="pref_name" className="block text-zinc-400 uppercase font-bold">Apelido Preferido</label>
              <input
                id="pref_name"
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-red-950 bg-black text-amber-100 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/60 transition-all font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="birth_full_name" className="block text-zinc-400 uppercase font-bold">Nome de Batismo</label>
              <input
                id="birth_full_name"
                type="text"
                placeholder="Insira para calcular a Expressão"
                value={birthName}
                onChange={(e) => setBirthName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-red-950 bg-black text-amber-100 placeholder-zinc-700 focus:outline-none focus:border-yellow-500/60 transition-all font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="birth_date_pref" className="block text-zinc-400 uppercase font-bold">Data de Nascimento</label>
              <input
                id="birth_date_pref"
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-red-950 bg-black text-amber-100 focus:outline-none focus:border-yellow-500/60 transition-all font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="birth_time_pref" className="block text-zinc-400 uppercase font-bold">Hora de seu nascimento</label>
              <input
                id="birth_time_pref"
                type="time"
                value={birthTime}
                onChange={(e) => setBirthTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-red-950 bg-black text-amber-100 focus:outline-none focus:border-yellow-500/60 transition-all font-mono animate-none"
              />
            </div>

            {successMsg && (
              <div className="text-[11px] font-semibold text-emerald-400 bg-emerald-950/20 py-2 border border-emerald-900/30 rounded-lg text-center font-sans">
                ✓ {successMsg}
              </div>
            )}

            <button
              id="save_profile_settings"
              type="submit"
              disabled={updating}
              className="w-full py-2.5 font-bold bg-zinc-900 hover:bg-zinc-800 border border-yellow-500/30 hover:border-yellow-500 text-yellow-400 rounded-lg transition-all cursor-pointer uppercase text-xs"
            >
              {updating ? "RE-ASSINANDO NAS FOLHAS..." : "SALVAR ALTERAÇÕES"}
            </button>

          </form>

        </div>
      </div>

    </div>
  );
}