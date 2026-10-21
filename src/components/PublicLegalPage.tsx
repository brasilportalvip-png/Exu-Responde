import React, { useEffect } from "react";
import { ShieldCheck, FileText, Lock, AlertTriangle, ArrowLeft, Mail, HeartHandshake, Scale, Award } from "lucide-react";

export type LegalRoute =
  | "termos"
  | "privacidade"
  | "cookies"
  | "pagamentos-creditos"
  | "reembolso"
  | "responsabilidade"
  | "lgpd"
  | "contato";

interface PublicLegalPageProps {
  route: LegalRoute;
  onNavigateHome: () => void;
}

const LEGAL_METADATA: Record<LegalRoute, { title: string; desc: string; label: string }> = {
  termos: {
    title: "Termos de Uso | Exu Responde",
    desc: "Termos e condições de uso da plataforma Exu Responde para consultas espirituais e oráculos.",
    label: "Termos de Uso",
  },
  privacidade: {
    title: "Política de Privacidade | Exu Responde",
    desc: "Transparência sobre tratamento de dados pessoais, bases legais e segurança no Exu Responde.",
    label: "Política de Privacidade",
  },
  cookies: {
    title: "Política de Cookies | Exu Responde",
    desc: "Informações sobre cookies necessários, de sessão e de preferências no Exu Responde.",
    label: "Política de Cookies",
  },
  "pagamentos-creditos": {
    title: "Pagamentos e Créditos de Axé | Exu Responde",
    desc: "Regras de aquisição de créditos de Axé, segurança de pagamentos Mercado Pago e vigência.",
    label: "Pagamentos & Créditos",
  },
  reembolso: {
    title: "Política de Reembolso e Estorno | Exu Responde",
    desc: "Diretrizes claras sobre cancelamento, estorno de transações e preservação de créditos.",
    label: "Reembolso & Estorno",
  },
  responsabilidade: {
    title: "Termo de Responsabilidade Espiritual | Exu Responde",
    desc: "Natureza reflexiva e de sabedoria ancestral das consultas, sem promessas absolutas de milagres.",
    label: "Responsabilidade Espiritual",
  },
  lgpd: {
    title: "Direitos do Titular LGPD | Exu Responde",
    desc: "Como exercer seus direitos previstos pela Lei Geral de Proteção de Dados (Lei 13.709/2018).",
    label: "Conformidade LGPD",
  },
  contato: {
    title: "Canais Oficiais de Atendimento | Exu Responde",
    desc: "Entre em contato com a equipe de suporte e guardiões do portal Exu Responde.",
    label: "Canais de Contato",
  },
};

export default function PublicLegalPage({ route, onNavigateHome }: PublicLegalPageProps) {
  const meta = LEGAL_METADATA[route] || LEGAL_METADATA.termos;

  useEffect(() => {
    document.title = meta.title;
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute("content", meta.desc);

    const canonicalLink = document.querySelector('link[rel="canonical"]');
    if (canonicalLink) {
      canonicalLink.setAttribute("href", `https://exu-responde.vercel.app/${route}`);
    }
  }, [meta, route]);

  return (
    <div className="min-h-screen bg-black text-zinc-200 font-sans p-4 sm:p-8 flex flex-col items-center">
      <div className="w-full max-w-4xl bg-zinc-950 border border-yellow-500/20 rounded-3xl p-6 sm:p-10 shadow-2xl">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-zinc-800 pb-6 gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full overflow-hidden bg-zinc-900 border border-yellow-500/40 p-1">
              <img src="/images/Exu Responde Logo.png" alt="Exu Responde" className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black font-mono tracking-wider text-yellow-400 uppercase">
                {meta.label}
              </h1>
              <p className="text-xs text-zinc-500 font-mono">Exu Responde • Portal de Sabedoria Ancestral</p>
            </div>
          </div>

          <button
            onClick={onNavigateHome}
            className="self-start sm:self-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-yellow-400 border border-yellow-500/30 text-xs font-mono font-bold transition cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar ao Portal
          </button>
        </div>

        {/* Content Body */}
        <div className="mt-8 text-sm leading-relaxed text-zinc-300 space-y-6">
          {route === "termos" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">1. Aceitação dos Termos</h2>
              <p>
                Ao acessar o portal <strong>Exu Responde</strong>, você declara ter ao menos 18 anos de idade e concorda integralmente com as presentes condições de uso, pautadas na seriedade, no respeito às tradições de terreiro e na transparência nas consultas oraculares.
              </p>
              <h2 className="text-lg font-bold text-amber-200">2. Natureza dos Serviços</h2>
              <p>
                O portal oferece consultas espirituais, cálculos fundamentados em Odùs, numerologia ancestral, lançamentos sagrados de 16 búzios e leituras de tarot através de CSPRNG e processamento inteligente server-side.
              </p>
              <h2 className="text-lg font-bold text-amber-200">3. Créditos de Axé</h2>
              <p>
                As consultas requerem créditos de Axé, adquiridos exclusivamente por meio de canais oficiais e integrados ao sistema financeiro imutável da plataforma.
              </p>
            </>
          )}

          {route === "privacidade" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">1. Coleta e Finalidade</h2>
              <p>
                Coletamos dados estritamente necessários para o cálculo natal e personalização oracular: nome, data de nascimento, horário e local de nascimento (quando informado).
              </p>
              <h2 className="text-lg font-bold text-amber-200">2. Segurança dos Dados</h2>
              <p>
                Não comercializamos dados com terceiros. Credenciais de acesso são administradas pelo Firebase Authentication com isolamento fail-closed.
              </p>
              <h2 className="text-lg font-bold text-amber-200">3. Retenção e Minimização</h2>
              <p>
                Dados de identificação técnica (como hashes de endereço) são mantidos apenas para prevenção contra ataques de força bruta e fraudes operacionais.
              </p>
            </>
          )}

          {route === "cookies" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Política de Cookies e Armazenamento</h2>
              <p>
                Utilizamos cookies técnicos essenciais para manter a integridade da sua sessão autenticada e garantir a proteção contra requisições automatizadas maliciosas.
              </p>
              <p>
                Métricas agregadas anônimas nos permitem aferir o volume de acessos e aperfeiçoar os oráculos oferecidos aos consulentes.
              </p>
            </>
          )}

          {route === "pagamentos-creditos" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Regras de Créditos e Pagamentos</h2>
              <p>
                O Axé é a moeda de troca interna do portal. Cada plano confere uma quantidade de créditos para realização de consultas de Tarot, Búzios, Numerologia e Chat.
              </p>
              <p>
                Todas as transações financeiras são intermediadas com segurança criptografada pelo Mercado Pago via PIX e cartão.
              </p>
            </>
          )}

          {route === "reembolso" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Garantia de Preservação e Estorno</h2>
              <p>
                Caso ocorra qualquer oscilação técnica ou falha de comunicação nos oráculos durante uma consulta paga, o sistema estorna automaticamente os créditos debitados e reverte pontuações associadas.
              </p>
              <p>
                Para cancelamento de pacotes de créditos não utilizados, o titular pode acionar nossos canais em até 7 dias após a compra, conforme o Código de Defesa do Consumidor.
              </p>
            </>
          )}

          {route === "responsabilidade" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Termo de Responsabilidade Espiritual</h2>
              <p>
                As orientações espirituais trazidas pelos oráculos destinam-se ao autoconhecimento, reflexão estratégica e direcionamento pessoal na jornada do consulente.
              </p>
              <p>
                Nenhuma leitura espiritual substitui aconselhamento médico, psicológico, jurídico ou financeiro profissional formal.
              </p>
            </>
          )}

          {route === "lgpd" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Seus Direitos Sob a LGPD (Lei 13.709/2018)</h2>
              <p>
                Garantimos aos buscadores o livre exercício de seus direitos: confirmação de tratamento, acesso facilitado ao perfil, retificação de dados incorretos e exclusão de perfil conforme diretrizes de retenção e compliance.
              </p>
            </>
          )}

          {route === "contato" && (
            <>
              <h2 className="text-lg font-bold text-amber-200">Atendimento ao Buscador</h2>
              <p>
                Nossa equipe de suporte técnico e zelo ancestral está à disposição pelo e-mail:
              </p>
              <div className="p-4 bg-zinc-900/60 rounded-xl border border-zinc-800 text-yellow-400 font-mono">
                contato@exu-responde.com / brasilportalvip@gmail.com
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
