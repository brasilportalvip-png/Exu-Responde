import nodemailer from "nodemailer";

export interface OutboxEmailRecord {
  id: string; // paymentId + "_" + type
  type: "purchase_customer" | "purchase_admin" | "refund_customer" | "refund_admin";
  recipient: string;
  paymentId: string;
  orderId?: string;
  subject: string;
  htmlContent: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  createdAt: string;
  sentAt?: string;
  lastError?: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

function getTransporter() {
  if (!isEmailConfigured()) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function queueAndSendPurchaseEmails(
  firestore: any,
  params: {
    paymentId: string;
    orderId: string;
    customerEmail: string;
    customerName: string;
    planName: string;
    amount: number;
    credits: number;
    newBalance: number;
    approvedAt: string;
  }
): Promise<{ customerSent: boolean; adminSent: boolean }> {
  const adminEmail = process.env.ADMIN_SALES_EMAIL?.trim() || "";
  const fromEmail = process.env.EMAIL_FROM?.trim() || "Exu Responde <contato@exu-responde.com>";

  const customerNameSafe = escapeHtml(params.customerName);
  const planNameSafe = escapeHtml(params.planName);
  const customerEmailSafe = escapeHtml(params.customerEmail);
  const paymentIdSafe = escapeHtml(params.paymentId);
  const orderIdSafe = escapeHtml(params.orderId);
  const approvedAtSafe = escapeHtml(params.approvedAt);

  const customerEmailId = `purchase_customer_${params.paymentId}`;
  const adminEmailId = `purchase_admin_${params.paymentId}`;

  const transporter = getTransporter();

  // 1. Template do Comprador com escaping rigoroso
  const customerHtml = `
    <div style="font-family: Arial, sans-serif; background: #09090b; color: #f4f4f5; padding: 24px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid #3f3f46;">
      <h2 style="color: #ef4444; margin-top: 0;">🔱 Exu Responde — Confirmação de Axé</h2>
      <p>Salve, <strong>${customerNameSafe}</strong>!</p>
      <p>Sua aquisição de Axé foi confirmada com sucesso em nossos caminhos.</p>
      <div style="background: #18181b; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #27272a;">
        <p style="margin: 4px 0;"><strong>Plano:</strong> ${planNameSafe}</p>
        <p style="margin: 4px 0;"><strong>Créditos adicionados:</strong> +${params.credits} Axé</p>
        <p style="margin: 4px 0;"><strong>Valor pago:</strong> R$ ${params.amount.toFixed(2)}</p>
        <p style="margin: 4px 0;"><strong>Novo saldo disponível:</strong> ${params.newBalance} Axé</p>
        <p style="margin: 4px 0;"><strong>Identificador da Transação:</strong> ${paymentIdSafe}</p>
        <p style="margin: 4px 0;"><strong>Data de Confirmação:</strong> ${approvedAtSafe}</p>
      </div>
      <p style="font-size: 13px; color: #a1a1aa;">Seus créditos já estão disponíveis em seu perfil para consultas de oráculos e leituras sagradas.</p>
      <p style="font-size: 12px; color: #71717a; margin-top: 24px;">Em caso de dúvidas ou necessidade de suporte, responda a este e-mail.</p>
    </div>
  `;

  // 2. Template do Administrador com escaping rigoroso
  const adminHtml = `
    <div style="font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; max-width: 600px; margin: 0 auto; border: 1px solid #1e293b;">
      <h3 style="color: #38bdf8; margin-top: 0;">🔔 Nova Venda Aprovada — Exu Responde</h3>
      <p>Uma nova compra de créditos foi processada e confirmada via Mercado Pago.</p>
      <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Comprador:</strong> ${customerNameSafe} (${customerEmailSafe})</p>
        <p style="margin: 4px 0;"><strong>Plano:</strong> ${planNameSafe}</p>
        <p style="margin: 4px 0;"><strong>Valor:</strong> R$ ${params.amount.toFixed(2)}</p>
        <p style="margin: 4px 0;"><strong>Créditos Concedidos:</strong> +${params.credits} Axé</p>
        <p style="margin: 4px 0;"><strong>Saldo Atual do Usuário:</strong> ${params.newBalance} Axé</p>
        <p style="margin: 4px 0;"><strong>Payment ID:</strong> ${paymentIdSafe}</p>
        <p style="margin: 4px 0;"><strong>Order ID:</strong> ${orderIdSafe}</p>
        <p style="margin: 4px 0;"><strong>Horário:</strong> ${approvedAtSafe}</p>
      </div>
    </div>
  `;

  let customerSent = false;
  let adminSent = false;

  // Envio / Gravação Idempotente no Outbox para o Cliente
  if (firestore) {
    const custDocRef = firestore.collection("email_outbox").doc(customerEmailId);
    const custSnap = await custDocRef.get();

    if (!custSnap.exists || custSnap.data()?.status !== "sent") {
      let custStatus = "pending";
      let errorMsg: string | undefined;

      if (transporter && params.customerEmail) {
        try {
          await transporter.sendMail({
            from: fromEmail,
            to: params.customerEmail,
            subject: `Confirmação de Axé — ${params.planName} no Exu Responde`,
            html: customerHtml,
          });
          custStatus = "sent";
          customerSent = true;
        } catch (err: any) {
          custStatus = "failed";
          errorMsg = err.message || String(err);
          console.error("[EMAIL] Falha ao enviar para comprador:", err);
        }
      }

      await custDocRef.set({
        id: customerEmailId,
        type: "purchase_customer",
        recipient: params.customerEmail,
        paymentId: params.paymentId,
        orderId: params.orderId,
        subject: `Confirmação de Axé — ${params.planName}`,
        htmlContent: customerHtml,
        status: custStatus,
        attempts: 1,
        createdAt: new Date().toISOString(),
        sentAt: custStatus === "sent" ? new Date().toISOString() : undefined,
        lastError: errorMsg,
      });
    } else {
      customerSent = true;
    }

    // Envio / Gravação Idempotente no Outbox para o Administrador
    const admDocRef = firestore.collection("email_outbox").doc(adminEmailId);
    const admSnap = await admDocRef.get();

    if (!admSnap.exists || admSnap.data()?.status !== "sent") {
      let admStatus = "pending";
      let errorMsg: string | undefined;

      if (transporter && adminEmail) {
        try {
          await transporter.sendMail({
            from: fromEmail,
            to: adminEmail,
            subject: `[Venda Aprovada] ${params.customerName} comprou ${params.planName} (R$ ${params.amount.toFixed(2)})`,
            html: adminHtml,
          });
          admStatus = "sent";
          adminSent = true;
        } catch (err: any) {
          admStatus = "failed";
          errorMsg = err.message || String(err);
          console.error("[EMAIL] Falha ao enviar para admin:", err);
        }
      }

      await admDocRef.set({
        id: adminEmailId,
        type: "purchase_admin",
        recipient: adminEmail,
        paymentId: params.paymentId,
        orderId: params.orderId,
        subject: `[Venda Aprovada] R$ ${params.amount.toFixed(2)} - ${params.customerName}`,
        htmlContent: adminHtml,
        status: admStatus,
        attempts: 1,
        createdAt: new Date().toISOString(),
        sentAt: admStatus === "sent" ? new Date().toISOString() : undefined,
        lastError: errorMsg,
      });
    } else {
      adminSent = true;
    }
  }

  return { customerSent, adminSent };
}

export async function processPendingOutboxEmails(
  firestore: any
): Promise<{ processed: number; sent: number; failed: number }> {
  if (!firestore || !isEmailConfigured()) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  const transporter = getTransporter();
  if (!transporter) return { processed: 0, sent: 0, failed: 0 };

  const fromEmail = process.env.EMAIL_FROM?.trim() || "Exu Responde <contato@exu-responde.com>";

  const snap = await firestore
    .collection("email_outbox")
    .where("status", "in", ["pending", "failed"])
    .limit(10)
    .get();

  let sent = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const item = doc.data() as OutboxEmailRecord;
    const currentAttempts = Number(item.attempts || 1);

    if (currentAttempts >= 5) {
      continue; // Excedeu tentativas máximas
    }

    try {
      await transporter.sendMail({
        from: fromEmail,
        to: item.recipient,
        subject: item.subject,
        html: item.htmlContent || `<p>Notificação oficial de Axé do Exu Responde para a transação ${item.paymentId}.</p>`,
      });

      await doc.ref.update({
        status: "sent",
        sentAt: new Date().toISOString(),
        attempts: currentAttempts + 1,
        lastError: null,
      });
      sent++;
    } catch (err: any) {
      failed++;
      await doc.ref.update({
        status: "failed",
        attempts: currentAttempts + 1,
        lastError: err.message || String(err),
      });
    }
  }

  return { processed: snap.size, sent, failed };
}
