import nodemailer from "nodemailer";
import { env } from "./env";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.mail.host || !env.mail.user) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.port === 465,
      auth: { user: env.mail.user, pass: env.mail.pass },
    });
  }
  return transporter;
}

function otpContent(code: string) {
  const subject = "Votre code de confirmation Alanya";
  const text = `Bienvenue sur Alanya !\n\nVotre code de confirmation est : ${code}\n\nIl expire dans ${env.otp.ttlMinutes} minutes.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto">
      <h2 style="color:#8a4b2b">Alanya</h2>
      <p>Bienvenue ! Votre code de confirmation est :</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#8a4b2b">${code}</p>
      <p style="color:#666">Ce code expire dans ${env.otp.ttlMinutes} minutes.</p>
    </div>`;
  return { subject, text, html };
}

function resolveProvider(): "smtp" | "console" {
  const p = env.mail.provider();
  if (p === "smtp" || p === "firebase" || p === "auto") {
    if (getTransporter()) return "smtp";
    if (p === "firebase") {
      console.warn("[mailer] MAIL_PROVIDER=firebase non disponible en v1 — configure Gmail (smtp) ou console");
    }
    return "console";
  }
  return "console";
}

/** Envoie le code OTP par email (SMTP Gmail ou console en dev). */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const { subject, text, html } = otpContent(code);
  const provider = resolveProvider();

  if (provider === "smtp") {
    const tx = getTransporter()!;
    await tx.sendMail({ from: env.mail.from, to, subject, text, html });
    console.log(`[mailer] OTP envoyé par SMTP à ${to}`);
    return;
  }

  console.log(`[mailer] (dev) Code OTP pour ${to} : ${code}`);
  if (env.mail.provider() === "smtp") {
    console.warn(
      "[mailer] MAIL_PROVIDER=smtp mais SMTP_USER/SMTP_PASS manquants — configure Gmail dans .env",
    );
  }
}
