import React, { useState } from "react";
import { Coins, Gift } from "lucide-react";
import { AudioEngine } from "./AudioEngine";
import { UserProfile, CreditPlan } from "../types";

interface PremiumCreditsProps {
  user: UserProfile;
  onUpdateUser: (updated: UserProfile) => void;
  onClose?: () => void;
}

const CREDIT_PLANS: CreditPlan[] = [
  { id: "plan_prata", name: "Plano Prata", price: 49.0, credits: 100, bonus: 0, color: "from-zinc-700 to-zinc-900" },
  { id: "plan_ouro", name: "Plano Ouro", price: 120.0, credits: 300, bonus: 0, popular: true, color: "from-yellow-700 via-yellow-600 to-amber-950" }
];

export default function PremiumCredits({ user }: PremiumCreditsProps) {
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);

  const checkoutPlan = async (plan: CreditPlan) => {
    setLoadingPlanId(plan.id);
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

      if (!res.ok) {
        throw new Error(data.error || "Erro ao criar pagamento.");
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      alert("Checkout Mercado Pago não retornou URL.");
    } catch (e: any) {
      alert("Erro ao criar pagamento: " + e.message);
    } finally {
      setLoadingPlanId(null);
    }
  };

  return (
    <div id="premium_credits_module" className="space-y-6 font-sans select-none">
      <div className="text-center max-w-xl mx-auto space-y-1 select-none">
        <span className="text-[10px] font-mono tracking-widest text-red-500 font-bold uppercase">
          Abundância & Câmbio de Axé
        </span>

        <h2 className="text-xl font-extrabold text-yellow-400 tracking-wider uppercase">
          Créditos de Consulta Espiritual
        </h2>

        <p className="text-xs text-zinc-400 leading-normal">
          Para garantir o equilíbrio ético de Ifá, todas as consultas e análises profundas exigem uma fração de axé.
          Adquira créditos e evolua seus níveis.
        </p>
      </div>

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

            <div>
              <span className="text-zinc-500 font-mono text-[9px] uppercase tracking-wider block mb-1">
                Carga Astral
              </span>

              <h4 className="text-amber-100 font-extrabold text-sm tracking-wider uppercase mb-3">
                {plan.name}
              </h4>

              <div className="flex items-center gap-1.5 my-3 bg-black/60 p-3 rounded-2xl border border-red-950/20">
                <Coins className="w-5 h-5 text-yellow-500" />

                <div>
                  <span className="text-xl font-mono font-black text-yellow-400">
                    {plan.credits + plan.bonus}
                  </span>
                  <span className="text-[10px] text-zinc-400 font-mono block">
                    Créditos Totais
                  </span>
                </div>
              </div>

              {plan.bonus > 0 && (
                <p className="text-[10px] text-yellow-500 font-mono uppercase font-bold flex items-center gap-1 mb-4 select-none">
                  <Gift className="w-3.5 h-3.5" /> Inclui +{plan.bonus} Bônus do Terreiro
                </p>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-zinc-900 space-y-3">
              <div className="flex items-baseline gap-1">
                <span className="text-xs font-mono text-zinc-500">R$</span>
                <span className="text-2xl font-mono font-black text-amber-50">
                  {plan.price.toFixed(2).replace(".", ",")}
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">pix</span>
              </div>

              <button
                id={`buy_plan_${plan.id}`}
                onClick={() => checkoutPlan(plan)}
                disabled={loadingPlanId === plan.id}
                className="w-full py-2.5 font-bold bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-400 hover:to-amber-500 text-black text-xs rounded-xl transition-all cursor-pointer select-none uppercase tracking-widest shadow-sm disabled:opacity-50"
              >
                {loadingPlanId === plan.id ? "ABRINDO MERCADO PAGO..." : "ADQUIRIR AXÉ"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}