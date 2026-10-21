/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ShieldCheck, FileText, Lock, AlertTriangle, X, CheckCircle } from "lucide-react";

export type LegalTab = "termos" | "privacidade" | "responsabilidade" | "cookies";

interface LegalModalProps {
  initialTab?: LegalTab;
  isOpen: boolean;
  onClose: () => void;
}

export default function LegalModal({ initialTab = "termos", isOpen, onClose }: LegalModalProps) {
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="legal_modal_overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[99999] bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
        >
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          className="relative w-full max-w-3xl bg-zinc-950 border border-yellow-500/30 rounded-3xl p-5 sm:p-8 shadow-[0_0_50px_rgba(0,0,0,0.95)] max-h-[85vh] flex flex-col font-sans text-left"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 pb-4 select-none">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-yellow-500" />
              <div>
                <h2 className="text-sm sm:text-base font-black font-mono tracking-wider text-yellow-400 uppercase">
                  Conformidade, Legalidade & Transparência
                </h2>
                <span className="text-[10px] font-mono text-zinc-500">Exu Responde • Portal de Sabedoria Ancestral</span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Sub Navigation */}
          <div className="flex gap-2 py-3 overflow-x-auto border-b border-zinc-900 select-none">
            {[
              { id: "termos", label: "Termos de Uso", icon: <FileText className="w-3.5 h-3.5" /> },
              { id: "privacidade", label: "Privacidade & LGPD", icon: <Lock className="w-3.5 h-3.5" /> },
              { id: "responsabilidade", label: "Isenção de Responsabilidade", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
              { id: "cookies", label: "Política de Cookies", icon: <CheckCircle className="w-3.5 h-3.5" /> },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as LegalTab)}
                className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold tracking-wider cursor-pointer shrink-0 transition-all flex items-center gap-1.5 ${
                  activeTab === tab.id
                    ? "bg-yellow-500 text-black shadow-md shadow-yellow-500/20"
                    : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content Body */}
          <div className="flex-1 overflow-y-auto pr-2 py-4 space-y-4 text-xs text-zinc-300 leading-relaxed font-sans scrolling-pane select-text">
            {activeTab === "termos" && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-yellow-400 uppercase font-mono">1. Termos e Condições Gerais de Uso</h3>
                <p>
                  Bem-vindo ao <strong>Exu Responde</strong>. Ao acessar este portal, registrar sua conta e utilizar nossas consultas e oráculos digitais, você expressamente concorda com estes Termos de Uso. Caso não concorde, recomendamos a não utilização dos serviços.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">2. Natureza dos Serviços</h4>
                <p>
                  O Exu Responde é uma plataforma de orientação, discernimento e sabedoria ancestral baseada nas tradições de Ifá, oráculos dos Odùs, numerologia sagrada e tarô dos caminhos. Nenhuma consulta deve ser considerada como certeza fática irrefutável ou garantia de acontecimentos futuros.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">3. Sistema de Créditos de Axé</h4>
                <p>
                  As consultas e oráculos utilizam créditos virtuais ("Créditos de Axé"). Os créditos podem ser adquiridos via pacotes transparentes processados com segurança pelo Mercado Pago. Créditos consumidos em consultas completas concluídas com sucesso não são reembolsáveis. Em casos de instabilidade técnica confirmada do sistema onde a consulta não retorne resposta válida, o saldo de créditos é preservado ou estornado automaticamente.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">4. Elegibilidade e Conduta</h4>
                <p>
                  O serviço é destinado a maiores de 18 anos. É estritamente proibido o uso de automações (bots, scrapers, ataques de negação de serviço), criação abusiva de contas múltiplas com o objetivo de burlar créditos promocionais ou utilização para fins ilegais.
                </p>
              </div>
            )}

            {activeTab === "privacidade" && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-yellow-400 uppercase font-mono">Política de Privacidade & LGPD (Lei 13.709/2018)</h3>
                <p>
                  O Exu Responde está comprometido com a segurança e a privacidade dos dados de seus buscadores, em integral conformidade com a Lei Geral de Proteção de Dados (LGPD).
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">1. Dados Natais e Finalidade</h4>
                <p>
                  Coletamos seu nome completo de batismo/solteiro, data e hora de nascimento exclusivamente para calcular a matriz espiritual, o Odù de afinidade ancestral e as coordenadas numerológicas personalizadas da sua consulta. Esses dados constituem sua "assinatura natal espiritual" permanente e nunca são comercializados com terceiros.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">2. Dados de Terceiros</h4>
                <p>
                  Quando o consulente insere voluntariamente dados de outra pessoa (nome e nascimento para consulta de afinidade, sociedade ou terceiros), esses dados são processados transitoriamente para a interpretação e não geram cadastro de perfil de terceiros em nossa base.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">3. Direitos do Titular (Art. 18 LGPD)</h4>
                <p>
                  Você tem o direito de solicitar a confirmação da existência de tratamento, o acesso aos seus dados, a correção de dados incompletos ou inexatos, a anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos e a revogação do consentimento, através dos nossos canais de suporte.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">4. Segurança de Infraestrutura</h4>
                <p>
                  Utilizamos criptografia SSL/TLS em trânsito, tokens de sessão criptografados via Firebase Authentication e armazenamento protegido no Google Cloud Firestore com regras estritas de menor privilégio.
                </p>
              </div>
            )}

            {activeTab === "responsabilidade" && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-yellow-400 uppercase font-mono">Aviso Legal e Isenção de Responsabilidade</h3>
                <p className="bg-red-950/30 border border-red-900/50 p-3 rounded-xl text-amber-200 font-semibold">
                  ⚠️ ATENÇÃO: As respostas, leituras, oráculos e reflexões gerados no portal Exu Responde possuem caráter puramente cultural, espiritual, filosófico e de autoconhecimento.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">1. Não Substituição Profissional</h4>
                <p>
                  Em nenhuma hipótese as orientações fornecidas por este portal devem substituir conselhos profissionais qualificados, diagnósticos e tratamentos médicos ou psicológicos, aconselhamento jurídico, consultoria contábil ou financeira formal. Em situações de saúde ou emergência, consulte sempre profissionais habilitados.
                </p>
                <h4 className="text-xs font-bold text-amber-200 uppercase font-mono">2. Livre-Arbítrio e Escolhas Pessoais</h4>
                <p>
                  O consulente é o único e exclusivo responsável por todas as decisões que toma em sua vida prática, amorosa, financeira ou profissional. Exu ensina que os caminhos são trilhados pelas escolhas de cada ser humano.
                </p>
              </div>
            )}

            {activeTab === "cookies" && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-yellow-400 uppercase font-mono">Política de Cookies e Armazenamento Local</h3>
                <p>
                  Utilizamos cookies e armazenamento local (`localStorage`) estritamente necessários para o funcionamento e a segurança da plataforma:
                </p>
                <ul className="list-disc pl-5 space-y-1.5 text-zinc-300">
                  <li><strong>Cookies de Autenticação:</strong> Gerenciados pelo Firebase Auth para manter sua sessão com segurança ativa durante a navegação.</li>
                  <li><strong>Identificador de Dispositivo (`exu_device_id`):</strong> Utilizado exclusivamente pelo nosso sistema anti-abuso e prevenção a fraudes no resgate indevido de créditos promocionais.</li>
                  <li><strong>Preferências de Áudio:</strong> Para memorizar suas preferências de som e trilha ambiente no templo.</li>
                </ul>
                <p className="text-zinc-400 mt-2">
                  Não utilizamos cookies de terceiros para rastreamento de anúncios cruzados ou invasivos.
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-zinc-900 flex justify-end select-none">
            <button
              onClick={onClose}
              className="px-6 py-2.5 bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-xs uppercase tracking-wider rounded-xl transition cursor-pointer"
            >
              Compreendi e Concordo
            </button>
          </div>
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
}
