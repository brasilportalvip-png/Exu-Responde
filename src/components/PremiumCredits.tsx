/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Compass, Sparkles, ShieldCheck, CreditCard, Coins, Check, Gift } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, CreditPlan } from "../types";

interface PremiumCreditsProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
  onClose?: () => void;
}

const CREDIT_PLANS: CreditPlan[] = [
  { id: "plan_prata", name: "Plano Prata", price: 49.00, credits: 100, bonus: 0, color: "from-zinc-700 to-zinc-900" },
  { id: "plan_ouro", name: "Plano Ouro", price: 120.00, credits: 300, bonus: 0, popular: true, color: "from-yellow-700 via-yellow-600 to-amber-950" }
];

export default function PremiumCredits({ user, onUpdateUser, onClose }: PremiumCreditsProps) {
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [orderData, setOrderData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [successTx, setSuccessTx] = useState(false);

  const checkoutPlan = async (plan: CreditPlan) => {
    setLoading(true);
    setSelectedPlan(plan);
    setSuccessTx(false);
    AudioEngine.playCrystalBell();

    try {
      const res = await fetch("/api/credits/buy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id
        },
        body: JSON.stringify({
          planId: plan.id,
          paymentMethod: "pix"
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setOrderData(data);
    } catch (e: any) {
      alert("Erro ao instanciar ordem: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const copyPixClipboard = () => {
    if (!orderData) return;
    navigator.clipboard.writeText(orderData.qrCode);
    setCopied(true);
    AudioEngine.playCrystalBell();
    setTimeout(() => setCopied(false), 2000);
  };

  const simulatePaymentConfirmation = async () => {
    if (!orderData || !selectedPlan) return;
    setLoading(true);
    AudioEngine.playPortalSwoosh();

    try {
      const res = await fetch("/api/credits/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id
        },
        body: JSON.stringify({
          orderId: orderData.orderId,
          creditsToReceive: orderData.creditsToReceive,
          amount: orderData.amount
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Trigger bell for successful credit
      AudioEngine.playCrystalBell();
      AudioEngine.playThunderStrike();
      setSuccessTx(true);

      onUpdateUser({
        ...user,
        credits: data.newCredits,
        level: data.newLevel,
        xp: user.xp + data.xpAwarded
      });

      setTimeout(() => {
        setSelectedPlan(null);
        setOrderData(null);
        setSuccessTx(false);
        if (onClose) onClose();
      }, 4000);

    } catch (err: any) {
      alert("Confirmação falhou: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="premium_credits_module" className="space-y-6 font-sans select-none">
      
      {/* Visual Title Header */}
      <div className="text-center max-w-xl mx-auto space-y-1 select-none">
        <span className="text-[10px] font-mono tracking-widest text-red-500 font-bold uppercase">Abundância & Câmbio de Axé</span>
        <h2 className="text-xl font-extrabold text-yellow-400 tracking-wider uppercase">Créditos de Consulta Espiritual</h2>
        <p className="text-xs text-zinc-400 leading-normal">
          Para garantir o equilíbrio ético de Ifá, todas as consultas e análises profundas exigem uma fração de axé. Adquira créditos e evolua seus níveis.
        </p>
      </div>

      {/* Credit Plans list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
        {CREDIT_PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`relative rounded-3xl border flex flex-col justify-between overflow-hidden p-6 transition-all duration-300 backdrop-blur-md ${
              plan.popular
                ? "bg-gradient-to-b from-red-950/40 via-zinc-950 to-zinc-950 border-yellow-500/50 shadow-[0_10px_30px_rgba(234,179,8,0.12)] scale-102 lg:scale-105"
                : "bg-zinc-950/60 border-red-950/30 hover:border-red-900/30 shadow-md"
            }`}
          >
            {plan.popular && (
              <span className="absolute top-3 right-3 text-[8.5px] font-mono font-bold px-2 py-0.5 rounded-full bg-yellow-500 text-black tracking-wider uppercase shadow-sm">
                Mais Solicitado
              </span>
            )}

            {/* Plan Head info */}
            <div>
              <span className="text-zinc-500 font-mono text-[9px] uppercase tracking-wider block mb-1">Carga Astral</span>
              <h4 className="text-amber-100 font-extrabold text-sm tracking-wider uppercase mb-3">{plan.name}</h4>
              
              <div className="flex items-center gap-1.5 my-3 balance bg-black/60 p-3 rounded-2xl border border-red-950/20">
                <Coins className="w-5 h-5 text-yellow-500" />
                <div>
                  <span className="text-xl font-mono font-black text-yellow-400">{plan.credits + plan.bonus}</span>
                  <span className="text-[10px] text-zinc-400 font-mono block">Créditos Totais</span>
                </div>
              </div>

              {plan.bonus > 0 && (
                <p className="text-[10px] text-yellow-500 font-mono uppercase font-bold flex items-center gap-1 mb-4 select-none">
                  <Gift className="w-3.5 h-3.5" /> Inclui +{plan.bonus} Bônus do Terreiro
                </p>
              )}
            </div>

            {/* Checkout Pricing box */}
            <div className="mt-4 pt-4 border-t border-zinc-900 space-y-3">
              <div className="flex items-baseline gap-1">
                <span className="text-xs font-mono text-zinc-500">R$</span>
                <span className="text-2xl font-mono font-black text-amber-50">{plan.price.toFixed(2).replace(".",",")}</span>
                <span className="text-[10px] text-zinc-500 font-mono">pix/cartão</span>
              </div>

              <button
                id={`buy_plan_${plan.id}`}
                onClick={() => checkoutPlan(plan)}
                className="w-full py-2.5 font-bold bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-400 hover:to-amber-500 text-black text-xs rounded-xl transition-all cursor-pointer select-none uppercase tracking-widest shadow-sm"
              >
                Adquirir Axé
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Checkout Modal Simulation */}
      <AnimatePresence>
        {selectedPlan && orderData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-zinc-950 p-6 sm:p-8 rounded-3xl border border-red-950 max-w-md w-full relative space-y-6 text-center"
            >
              <button
                onClick={() => {
                  setSelectedPlan(null);
                  setOrderData(null);
                }}
                className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 text-sm font-mono cursor-pointer"
              >
                [FECHAR]
              </button>

              <div className="space-y-1">
                <span className="text-2xl text-yellow-500">⚜️</span>
                <h3 className="text-sm font-mono font-extrabold text-yellow-400 uppercase tracking-widest">
                  {successTx ? "AXÉ REIVINDICADO!" : "PAGAMENTO PIX COBRADO"}
                </h3>
                <p className="text-xs text-zinc-400 font-mono leading-normal">
                  {successTx ? "Suas moedas foram creditadas na sua alma cósmica." : `Recarga de +${orderData.creditsToReceive} créditos de Axé`}
                </p>
              </div>

              <AnimatePresence mode="wait">
                {successTx ? (
                  <motion.div
                    key="success_payment_screen"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="py-10 space-y-4"
                  >
                    <div className="w-16 h-16 bg-emerald-950/50 border border-emerald-500/40 rounded-full flex items-center justify-center text-3xl mx-auto shadow-[0_0_15px_rgba(16,185,129,0.2)]">
                      ✓
                    </div>
                    <div>
                      <h4 className="text-sm font-extrabold text-emerald-400 uppercase font-mono">TRANSFERÊNCIA CONCLUÍDA</h4>
                      <p className="text-[11px] text-zinc-400 mt-1 uppercase font-mono tracking-wider">
                        +{orderData.creditsToReceive} Moedas / +{Math.round(orderData.amount * 5)} XP outorgados
                      </p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="active_pix_invoice"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-4"
                  >
                    {/* Simulated High quality QR code */}
                    <div className="w-48 h-48 bg-white p-2.5 mx-auto rounded-2xl flex flex-col justify-center items-center shadow-md border-4 border-yellow-500">
                      <svg viewBox="0 0 100 100" className="w-full h-full text-black fill-current select-none">
                        {/* Nested qr grids */}
                        <rect x="0" y="0" width="30" height="30" />
                        <rect x="3" y="3" width="24" height="24" className="fill-white" />
                        <rect x="9" y="9" width="12" height="12" />

                        <rect x="70" y="0" width="30" height="30" />
                        <rect x="73" y="3" width="24" height="24" className="fill-white" />
                        <rect x="79" y="9" width="12" height="12" />

                        <rect x="0" y="70" width="30" height="30" />
                        <rect x="3" y="73" width="24" height="24" className="fill-white" />
                        <rect x="9" y="79" width="12" height="12" />

                        <rect x="35" y="10" width="10" height="25" />
                        <rect x="50" y="18" width="15" height="12" />
                        <rect x="38" y="45" width="25" height="15" />
                        <rect x="70" y="40" width="15" height="15" />
                        <rect x="15" y="40" width="15" height="15" />
                        <rect x="45" y="70" width="20" height="20" />
                        <rect x="75" y="75" width="20" height="20" />
                      </svg>
                    </div>

                    <p className="text-[10px] font-mono text-zinc-500">
                      Escaneie o QR Code em seu aplicativo bancário Mercado Pago, Nubank, Itaú ou copie o código abaixo.
                    </p>

                    {/* Copiar Pix link */}
                    <div className="flex gap-2">
                      <input
                        id="pix_code_display"
                        type="text"
                        readOnly
                        value={`${orderData.qrCode.substring(0, 32)}...`}
                        className="flex-1 bg-black text-center border border-zinc-900 rounded-lg py-2 font-mono text-[10px] text-zinc-400 select-all focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={copyPixClipboard}
                        className="px-3 bg-zinc-900 hover:bg-zinc-800 text-yellow-500 text-[10.5px] border border-yellow-500/30 rounded-lg cursor-pointer"
                      >
                        {copied ? "COPIADO!" : "COPIAR"}
                      </button>
                    </div>

                    {/* Simulation pay button */}
                    <button
                      id="simulate_transfer_btn"
                      onClick={simulatePaymentConfirmation}
                      disabled={loading}
                      className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-xs tracking-wider uppercase rounded-xl shadow-md cursor-pointer disabled:opacity-40 select-none animate-pulse"
                    >
                      {loading ? "PROCESSANDO LIQUIDAÇÃO..." : "SIMULAR PAGAMENTO PIX"}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="text-[9.5px] font-mono text-zinc-500 border-t border-zinc-900 pt-3 flex items-center justify-center gap-2">
                <span>🛡️ SISTEMA MERCADO PAGO INTEGRADO NO PORTAL</span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
