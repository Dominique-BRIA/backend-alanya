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

function otpContent(code: string, dureeMinutes: number) {
  const subject = "Votre code de confirmation Alanya";
  const text = `Bienvenue sur Alanya !\n\nVotre code de confirmation est : ${code}\n\nIl expire dans ${dureeMinutes} minutes.\n\nSi vous n'avez pas demandé ce code, ignorez cet email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:24px">
      <h2 style="color:#8a4b2b;margin-bottom:4px">Alanya</h2>
      <p style="color:#444">Votre code de confirmation :</p>
      <p style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#8a4b2b;
                background:#fff8f4;border-radius:12px;padding:16px;text-align:center;
                border:2px solid #e0b59a">${code}</p>
      <p style="color:#888;font-size:13px">Ce code expire dans ${dureeMinutes} minutes.</p>
      <p style="color:#aaa;font-size:12px">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
    </div>`;
  return { subject, text, html };
}

/** Résultat d'un envoi. `false` veut dire « rien n'est parti ». */
export type ResultatEnvoi = { remis: boolean; detail?: string };

/**
 * Envoie un code par courriel.
 *
 * 🔴 DEUX DÉFAUTS CORRIGÉS ICI LE 18/08/2026, tous deux devenus critiques du
 * jour où ce code garde une DOUBLE AUTHENTIFICATION.
 *
 * 1. **Le code n'est plus jamais écrit dans les journaux.** En cas d'échec SMTP,
 *    et aussi quand aucun SMTP n'était configuré, le code partait en clair dans
 *    `console.warn` — c'est-à-dire dans `pm2 logs`, sur le disque du VPS, dans
 *    les sauvegardes, et sous les yeux de quiconque a un accès SSH. Un facteur
 *    d'authentification déposé en clair dans un fichier n'est plus un facteur.
 *    Le repli existait pour « ne pas bloquer l'utilisateur en prod » ; il
 *    transformait une panne d'envoi en fuite silencieuse de tous les codes.
 *
 * 2. **L'échec remonte.** La fonction rendait `void` et avalait l'erreur :
 *    l'appelant ne pouvait pas distinguer « remis » de « perdu », et annonçait
 *    donc « envoyé avec succès » dans les deux cas. C'est exactement le défaut
 *    que la colonne `verification.livraison` sert à éliminer — elle ne vaut que
 *    si ce qu'on y écrit a été constaté.
 *
 * ⚠️ Le paramètre `dureeMinutes` : la durée dépend désormais de la finalité
 * (5 min pour une connexion, 15 pour une création de compte). La lire depuis
 * `env.otp.ttlMinutes` afficherait un délai faux dans le message.
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  dureeMinutes: number = env.otp.ttlMinutes,
): Promise<ResultatEnvoi> {
  const { subject, text, html } = otpContent(code, dureeMinutes);
  const tx = getTransporter();

  if (!tx) {
    // Aucun SMTP configuré. On le dit, et on ne livre pas — plutôt que de
    // publier le code dans les journaux en prétendant que c'est un repli.
    console.error("[mailer] SMTP non configuré : aucun envoi possible.");
    return { remis: false, detail: "SMTP non configuré" };
  }

  try {
    await tx.sendMail({ from: env.mail.from, to, subject, text, html });
    // Le destinataire, jamais le code.
    console.log(`[mailer] code envoyé par SMTP à ${to}`);
    return { remis: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[mailer] échec SMTP :", detail);
    return { remis: false, detail: detail.slice(0, 255) };
  }
}
