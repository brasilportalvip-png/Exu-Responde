/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Users, BarChart3, BookOpen, Settings, Plus, Key, Terminal, RefreshCw, Layers } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, KnowledgeItem } from "../types";
import { auth } from "../firebase";

interface AdminPanelProps {
  user: UserProfile;
}

type AdminSubTab = "analytics" | "knowledge" | "users" | "logs";

export default function AdminPanel({ user }: AdminPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<AdminSubTab>("analytics");
  
  // Library content inputs
  const [kbTitle, setKbTitle] = useState("");
  const [kbCategory, setKbCategory] = useState<any>("odu");
  const [kbContent, setKbContent] = useState("");
  const [kbTags, setKbTags] = useState("");
  const [kbLoading, setKbLoading] = useState(false);
  const [libraryData, setLibraryData] = useState<KnowledgeItem[]>([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [statusError, setStatusError] = useState("");

  // Statistics
  const [stats, setStats] = useState<any | null>(null);
  const [registrations, setRegistrations] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);

  const fetchAdminDataHash = async () => {
    setLoadingStats(true);
    setStatusError("");

    try {
      const firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        throw new Error(
          "Sua sessão expirou. Entre novamente para acessar o painel administrativo."
        );
      }

      const token = await firebaseUser.getIdToken();

      const hds = {
        "Authorization": `Bearer ${token}`,
        "x-user-id": user.id
      };

      const statsRes = await fetch("/api/admin/analytics", {
        headers: hds
      });

      const statsObj = await statsRes.json();

      if (!statsRes.ok) {
        throw new Error(
          statsObj.error || "Falha ao carregar analytics."
        );
      }

      const usersRes = await fetch("/api/admin/users", {
        headers: hds
      });

      const usersObj = await usersRes.json();

      if (!usersRes.ok) {
        throw new Error(
          usersObj.error || "Falha ao carregar usuários."
        );
      }

      const libRes = await fetch("/api/admin/library", {
        headers: hds
      });

      const libObj = await libRes.json();

      if (!libRes.ok) {
        throw new Error(
          libObj.error || "Falha ao carregar biblioteca."
        );
      }

      setStats(statsObj.stats);
      setLogs(usersObj.logs || []);
      setRegistrations(usersObj.seekers || []);
      setLibraryData(libObj.library || []);
    } catch (e: any) {
      console.error("Failed loading stats:", e);

      setStatusError(
        e?.message || "Falha ao carregar dados administrativos."
      );
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    fetchAdminDataHash();
  }, []);

  const handleAddKnowledgeItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kbTitle || !kbContent) return;

    setKbLoading(true);
    setStatusMsg("");
    setStatusError("");
    AudioEngine.playCrystalBell();

    try {
      const firebaseUser = auth.currentUser;

      if (!firebaseUser) {
        throw new Error(
          "Sua sessão expirou. Entre novamente para alterar a biblioteca."
        );
      }

      const token = await firebaseUser.getIdToken();

      const res = await fetch("/api/admin/library/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "x-user-id": user.id
        },
        body: JSON.stringify({
          title: kbTitle,
          category: kbCategory,
          content: kbContent,
          tags: kbTags
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Reset inputs
      setKbTitle("");
      setKbContent("");
      setKbTags("");
      
      // Update local array
      fetchAdminDataHash();
      setStatusMsg("Ensinamento de Ifá sintonizado com sucesso na mente astral!");
    } catch (err: any) {
      setStatusError("Falha na sintonização: " + err.message);
    } finally {
      setKbLoading(false);
    }
  };

  if (user.role !== "admin") {
    return (
      <div className="bg-red-950/20 border border-red-900/60 p-8 rounded-3xl text-center space-y-4 max-w-md mx-auto">
        <span className="text-4xl">🔱</span>
        <h3 className="text-sm font-bold text-yellow-500 uppercase tracking-widest font-mono">ACESSO PRIVADO</h3>
        <p className="text-xs text-zinc-400 font-sans leading-normal">
          Este painel contém segredos confidenciais de Ifá e informações de faturamento de créditos. Apenas sacerdotes do terreiro podem adentrar.
        </p>
      </div>
    );
  }

  return (
    <div id="admin_portal_section" className="space-y-6 font-sans text-left">
      
      {/* Title block */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-red-950/40 pb-4 select-none">
        <div>
          <span className="text-[9px] font-mono tracking-widest text-red-500 uppercase font-bold">Conselho Superior do Oráculo</span>
          <h2 className="text-lg font-black text-yellow-400 tracking-wider uppercase">PAINEL DO GUARDIÃO ADMINISTRADOR</h2>
        </div>
        
        <button
          onClick={fetchAdminDataHash}
          disabled={loadingStats}
          className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-yellow-500/20 rounded-xl text-[10.5px] font-mono text-yellow-500 flex items-center gap-2 cursor-pointer transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingStats ? 'animate-spin' : ''}`} />
          SINCRO-ASTRAL
        </button>
      </div>

      {/* Sub menu selectors */}
      <div className="flex gap-2 pb-1 overflow-x-auto select-none border-b border-red-950/20">
        {[
          { key: "analytics", label: "Analytics", icon: <BarChart3 className="w-3.5 h-3.5" /> },
          { key: "knowledge", label: "Biblioteca RAG", icon: <BookOpen className="w-3.5 h-3.5" /> },
          { key: "users", label: "Buscadores", icon: <Users className="w-3.5 h-3.5" /> },
          { key: "logs", label: "Logs do Sistema", icon: <Terminal className="w-3.5 h-3.5" /> }
        ].map((btn) => (
          <button
            key={btn.key}
            onClick={() => setActiveSubTab(btn.key as AdminSubTab)}
            className={`px-4 py-2 border rounded-xl text-xs font-mono font-semibold tracking-wider cursor-pointer shrink-0 transition-all flex items-center gap-2 ${
              activeSubTab === btn.key
                ? "bg-red-950/40 border-yellow-500/40 text-yellow-500"
                : "bg-black border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {btn.icon}
            {btn.label}
          </button>
        ))}
      </div>

      {/* RENDER ACTIVE SECTION */}
      {activeSubTab === "analytics" && (
        <div className="space-y-6">
          {/* Main big value cards */}
          {stats ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-zinc-950/80 p-5 rounded-2xl border border-red-950/40">
                <span className="text-[9.5px] font-mono text-zinc-500 block uppercase">Buscadores Conectados</span>
                <strong className="text-3xl font-black font-mono text-amber-50 mt-1 block">{stats.totalSeekers}</strong>
              </div>

              <div className="bg-zinc-950/80 p-5 rounded-2xl border border-red-950/40">
                <span className="text-[9.5px] font-mono text-zinc-500 block uppercase">Créditos de Axé Emitidos</span>
                <strong className="text-3xl font-black font-mono text-amber-50 mt-1 block">{stats.totalCreditsInCirculation}</strong>
              </div>

              <div className="bg-zinc-950/80 p-5 rounded-2xl border border-red-950/40">
                <span className="text-[9.5px] font-mono text-zinc-500 block uppercase">XP Consumido Global</span>
                <strong className="text-3xl font-black font-mono text-amber-50 mt-1 block">{stats.totalXpAccumulated}</strong>
              </div>

              <div className="bg-zinc-950/80 p-5 rounded-2xl border border-red-950/40">
                <span className="text-[9.5px] font-mono text-zinc-500 block uppercase">Biblioteca Documentos</span>
                <strong className="text-3xl font-black font-mono text-amber-50 mt-1 block">{stats.knowledgeItemsCount}</strong>
              </div>
            </div>
          ) : (
            <div className="text-center text-xs text-zinc-500">Mapeando estatísticas celestes...</div>
          )}

          {/* Quick AI parameters tuning */}
          <div className="bg-zinc-950/80 p-6 rounded-2xl border border-red-950/40">
            <h3 className="text-xs font-mono font-bold text-yellow-500 uppercase tracking-widest mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-yellow-500" />
              Sincronia Áuria (Gemini Calibration)
            </h3>
            <p className="text-xs text-zinc-400 mb-4 leading-normal">
              Ajuste as correntes de calor de respostas de Exu Responde. O modelo utiliza o conector de rede de luz `gemini-3.5-flash`.
            </p>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 font-mono text-xs">
              <div className="space-y-1">
                <p className="text-zinc-400 font-bold uppercase">Temperatura (Heat): 0.85</p>
                <div className="w-full bg-black h-2 rounded-lg border border-red-950">
                  <div className="w-[85%] bg-yellow-500 h-full rounded-lg" />
                </div>
                <small className="text-[9px] text-zinc-500">Respostas poéticas com alto teor metafórico</small>
              </div>

              <div className="space-y-1">
                <p className="text-zinc-400 font-bold uppercase">RAG Semantic Match threshold: 70%</p>
                <div className="w-full bg-black h-2 rounded-lg border border-red-950">
                  <div className="w-[70%] bg-yellow-500 h-full rounded-lg" />
                </div>
                <small className="text-[9px] text-zinc-500">Filtragem de tags no Terreiro base</small>
              </div>

              <div className="space-y-1">
                <p className="text-zinc-400 font-bold uppercase">Tokens de Retorno: Dinâmico</p>
                <div className="p-1 px-2.5 rounded border border-yellow-500/20 bg-black text-center text-yellow-400 font-mono text-[10.5px]">
                  ATIVO EM TEMPO REAL
                </div>
                <small className="text-[9px] text-zinc-500">Auto ajustável por tamanho de Itan</small>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: LIBRARY / SIMULATED PDF STORAGE FOR RAG */}
      {activeSubTab === "knowledge" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left panel: add new items */}
          <div className="bg-zinc-950/80 p-6 rounded-2xl border border-red-950/40 space-y-4">
            <h3 className="text-xs font-mono font-bold text-yellow-500 uppercase tracking-widest border-b border-zinc-900 pb-2">Alimentar Acervo de Sabedoria (Cadastro de Textos/PDF)</h3>
            
            <form onSubmit={handleAddKnowledgeItem} className="space-y-3.5 text-xs font-mono">
              {statusMsg && (
                <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-center font-bold">
                  ✔️ {statusMsg}
                </div>
              )}
              {statusError && (
                <div className="p-3 rounded-lg bg-red-950/60 border border-red-500/30 text-red-400 text-center font-bold">
                  ⚠️ {statusError}
                </div>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="kb_title_id" className="text-zinc-500 font-bold uppercase block">Título da Entrada</label>
                  <input
                    id="kb_title_id"
                    type="text"
                    required
                    value={kbTitle}
                    onChange={(e) => setKbTitle(e.target.value)}
                    placeholder="Ex: Odù Éjìolobà (12)"
                    className="w-full px-3 py-2 bg-black border border-red-950 rounded-lg text-amber-100 placeholder-zinc-800 text-[11.5px] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="kb_cat_id" className="text-zinc-500 font-bold uppercase block">Categoria</label>
                  <select
                    id="kb_cat_id"
                    value={kbCategory}
                    onChange={(e) => setKbCategory(e.target.value)}
                    className="w-full px-3 py-2 bg-black border border-red-950 rounded-lg text-amber-200 text-[11.5px] focus:outline-none"
                  >
                    <option value="odu">Odù de Ifá</option>
                    <option value="itan">Itan Sagrado (Lenda)</option>
                    <option value="orixa">Orixá / Entidade</option>
                    <option value="filosofia">Filosofia de Terreiro</option>
                    <option value="tarot">Tarot Símbolos</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="kb_content_id" className="text-zinc-500 font-bold uppercase block">Fundamentação e Conteúdo Teórico</label>
                <textarea
                  id="kb_content_id"
                  required
                  rows={4}
                  value={kbContent}
                  onChange={(e) => setKbContent(e.target.value)}
                  placeholder="Escreva a lenda, dados cabalísticos do Orixá ou Odù que servirá de contexto cognitivo no prompt do Gemini..."
                  className="w-full px-3 py-2 bg-black border border-red-950 rounded-lg text-amber-100 placeholder-zinc-800 text-[11.5px] focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="kb_tags_id" className="text-zinc-500 font-bold uppercase block">Tags de ativação do RAG (Separadas por vírgula)</label>
                <input
                  id="kb_tags_id"
                  type="text"
                  value={kbTags}
                  onChange={(e) => setKbTags(e.target.value)}
                  placeholder="Ex: egiodu, riqueza, ouro, caminhos"
                  className="w-full px-3 py-2 bg-black border border-red-950 rounded-lg text-amber-100 placeholder-zinc-800 text-[11.5px] focus:outline-none"
                />
                <small className="text-[10px] text-zinc-500 leading-normal block mt-1">
                  Tag Mapeadora: Se o usuário digitar alguma palavra que bata com essas tags, as informações serão servidas como conhecimento no prompt.
                </small>
              </div>

              <button
                id="sumbit_new_kb"
                type="submit"
                disabled={kbLoading}
                className="w-full py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-extrabold text-[11px] uppercase tracking-wider rounded-lg cursor-pointer"
              >
                {kbLoading ? "CONCEITUANDO SUTILEZAS..." : "VINCULAR NA BIBLIOTECA"}
              </button>
            </form>
          </div>

          {/* Right panel: list database items */}
          <div className="bg-zinc-950/80 p-6 rounded-2xl border border-red-950/40 overflow-hidden flex flex-col h-[400px]">
            <h3 className="text-xs font-mono font-bold text-yellow-500 uppercase tracking-widest border-b border-zinc-900 pb-2 mb-3">Biblioteca Ativa do Oráculo ({libraryData.length} registros)</h3>
            
            <div className="flex-1 overflow-y-auto space-y-3.5 scrollbar-thin scrollbar-thumb-zinc-900 pr-1">
              {libraryData.map((item) => (
                <div key={item.id} className="p-3 bg-black border border-zinc-900 rounded-lg">
                  <div className="flex justify-between items-center mb-1">
                    <strong className="text-amber-100 text-xs font-bold font-sans uppercase">{item.title}</strong>
                    <span className="text-[8.5px] font-mono px-2 py-0.5 rounded bg-red-950/20 text-red-500 border border-red-900/30 uppercase font-bold">
                      {item.category}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-zinc-400 leading-relaxed font-sans line-clamp-2">{item.content}</p>
                  
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.tags.map((tg, idx) => (
                      <span key={idx} className="text-[8.5px] font-mono text-zinc-500 select-none bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800">
                        #{tg}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: REGISTERED USERS LIST */}
      {activeSubTab === "users" && (
        <div className="bg-zinc-950/80 p-6 rounded-2xl border border-red-950/40 overflow-hidden">
          <h3 className="text-xs font-mono font-bold text-yellow-500 uppercase tracking-widest border-b border-zinc-900 pb-2 mb-4">Membros e Buscadores Conectados no Templo</h3>
          
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono text-zinc-400">
              <thead>
                <tr className="border-b border-zinc-900 text-zinc-500 text-left uppercase text-[10px] tracking-wider">
                  <th className="py-2.5">Buscador</th>
                  <th>E-mail</th>
                  <th>Cargo</th>
                  <th>Patamar</th>
                  <th>XP</th>
                  <th>Créditos Axé</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((seeker) => (
                  <tr key={seeker.id} className="border-b border-zinc-900/40 hover:bg-zinc-900/10">
                    <td className="py-3 font-bold text-amber-200">{seeker.name}</td>
                    <td className="text-zinc-500">{seeker.email}</td>
                    <td className="uppercase">{seeker.role}</td>
                    <td className="font-bold text-yellow-500 uppercase text-[10px]">{seeker.level}</td>
                    <td>{seeker.xp} XP</td>
                    <td className="font-bold text-zinc-200">{seeker.credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: SYSTEM logs TRACE */}
      {activeSubTab === "logs" && (
        <div className="bg-zinc-950/80 p-6 rounded-2xl border border-red-950/40 overflow-hidden flex flex-col h-[350px]">
          <h3 className="text-xs font-mono font-bold text-yellow-500 uppercase tracking-widest border-b border-zinc-900 pb-2 mb-3">Logs do Servidor / Transações Espirituais</h3>
          
          <div className="flex-1 overflow-y-auto space-y-2.5 font-mono text-[10.5px] text-zinc-400">
            {logs.map((log) => (
              <div key={log.id} className="p-2.5 bg-black border border-zinc-900 rounded-lg flex flex-col sm:flex-row justify-between gap-1.5 hover:border-yellow-500/10 transition-all">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-red-500 uppercase font-bold text-[9px]">{log.action}</span>
                    <span className="text-zinc-600">|</span>
                    <span className="text-zinc-300 font-sans">{log.details}</span>
                  </div>
                  <p className="text-[9.5px] text-zinc-600">ID Buscador: {log.userId}</p>
                </div>
                
                <span className="text-zinc-600 text-[10px] sm:self-start shrink-0 select-none">
                  {new Date(log.timestamp).toLocaleTimeString()} {new Date(log.timestamp).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}