import nodemailer from "nodemailer";
import { env } from "./env";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.mail.host || !env.mail.user || !env.mail.pass) return null;
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
  const text = `Bienvenue sur Alanya !\n\nVotre code de confirmation est : ${code}\n\nIl expire dans ${env.otp.ttlMinutes} minutes.\n\nSi vous n'avez pas demandé ce code, ignorez cet email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:24px">
      <h2 style="color:#8a4b2b;margin-bottom:4px">Alanya</h2>
      <p style="color:#444">Votre code de confirmation :</p>
      <p style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#8a4b2b;
                background:#fff8f4;border-radius:12px;padding:16px;text-align:center;
                border:2px solid #e0b59a">${code}</p>
      <p style="color:#888;font-size:13px">Ce code expire dans ${env.otp.ttlMinutes} minutes.</p>
      <p style="color:#aaa;font-size:12px">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
    </div>`;
  return { subject, text, html };
}

/** Envoie le code OTP par email. Tente SMTP si configuré, sinon affiche dans les logs. */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const { subject, text, html } = otpContent(code);
  const tx = getTransporter();

  if (tx) {
    try {
      await tx.sendMail({ from: env.mail.from, to, subject, text, html });
      console.log(`[mailer] OTP envoyé par SMTP à ${to}`);
      return;
    } catch (err) {
      // Si SMTP échoue, on logue l'erreur ET on affiche le code dans les logs
      // pour ne pas bloquer l'utilisateur en prod.
      console.error("[mailer] Erreur SMTP :", err);
      console.warn(`[mailer] FALLBACK — Code OTP pour ${to} : ${code}`);
      return;
    }
  }

  // Pas de SMTP configuré : affiche le code dans les logs Vercel
  // Utile en développement ou si SMTP non configuré.
  console.log(`\n================================================`);
  console.log(`[mailer] CODE OTP pour ${to} : ${code}`);
  console.log(`================================================\n`);
  console.warn("[mailer] MAIL_PROVIDER=console — configure SMTP_HOST, SMTP_USER, SMTP_PASS dans les variables Vercel pour envoyer de vrais emails.");
}
