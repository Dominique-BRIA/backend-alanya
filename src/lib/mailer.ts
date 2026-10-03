import nodemailer from "nodemailer";
import { env } from "./env";
import { choisirFournisseur, envoyerParBird, envoyerParPostmark } from "./courriel.mjs";
import { contenuCode, etiquetteDuMotif, MOTIF } from "./courriel-contenu.mjs";

/** Pourquoi un code part : décide du texte ET du fournisseur. */
export type MotifCourriel = (typeof MOTIF)[keyof typeof MOTIF];
export { MOTIF };

let transporter: nodemailer.Transporter | null = null;

function smtpConfigure(): boolean {
  return Boolean(env.mail.host && env.mail.user && env.mail.pass);
}

function getTransporter(): nodemailer.Transporter | null {
  if (!smtpConfigure()) return null;
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

// Une valeur inconnue de MAIL_PROVIDER ne se signale qu'une fois par process :
// la répéter à chaque code noierait les journaux sans rien apprendre de plus.
let valeurInconnueSignalee = false;

function fournisseur(motif: MotifCourriel) {
  const choix = choisirFournisseur({
    provider: env.mail.provider(),
    motif,
    jetonPostmark: env.mail.postmark.serverToken(),
    cleBird: env.mail.bird.apiKey(),
    smtpConfigure: smtpConfigure(),
  });
  if (choix.inconnu && !valeurInconnueSignalee) {
    valeurInconnueSignalee = true;
    console.warn(`[mailer] MAIL_PROVIDER="${env.mail.provider()}" inconnu : traité comme "auto".`);
  }
  return choix;
}

/** Résultat d'un envoi. `false` veut dire « rien n'est parti ». */
export type ResultatEnvoi = { remis: boolean; detail?: string };

/**
 * Envoie un code par courriel, par Postmark, par Bird ou par le relais SMTP
 * selon le MOTIF et `MAIL_PROVIDER` (voir `choisirFournisseur`,
 * src/lib/courriel.mjs).
 *
 * 🔴 LE MOTIF DÉCIDE DU TEXTE ET DU FOURNISSEUR (03/10/2026). Un seul texte
 * français partait pour tout — « Bienvenue sur Alanya ! » y compris pour un mot
 * de passe oublié. Chaque motif a désormais le sien, dans la langue que le
 * client déclare (`Accept-Language`) : voir `courriel-contenu.mjs`.
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
 *
 * ⚠️ Un échec Postmark NE retombe PAS sur SMTP : voir `choisirFournisseur`.
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  dureeMinutes: number = env.otp.ttlMinutes,
  options: {
    motif?: MotifCourriel;
    /** Code de langue ou en-tête `Accept-Language` complet. Absent = français. */
    langue?: string | null;
  } = {},
): Promise<ResultatEnvoi> {
  const motif = options.motif ?? MOTIF.INSCRIPTION;
  const { subject, text, html } = contenuCode({ motif, code, dureeMinutes, langue: options.langue });
  const tag = etiquetteDuMotif(motif);
  const choix = fournisseur(motif);

  if (choix.fournisseur === "postmark") {
    const resultat = await envoyerParPostmark(
      { to, subject, text, html, tag },
      {
        jeton: env.mail.postmark.serverToken(),
        expediteur: env.mail.postmark.from(),
        flux: env.mail.postmark.messageStream(),
      },
    );
    // Le destinataire et le motif, jamais le code.
    if (resultat.remis) console.log(`[mailer] ${tag} envoyé par Postmark à ${to}`);
    else console.error(`[mailer] échec Postmark (${tag}) :`, resultat.detail);
    return resultat;
  }

  if (choix.fournisseur === "bird") {
    const resultat = await envoyerParBird(
      { to, subject, text, html, tag },
      {
        cle: env.mail.bird.apiKey(),
        hote: env.mail.bird.apiUrl(),
        expediteur: env.mail.bird.from(),
      },
    );
    if (resultat.remis) console.log(`[mailer] ${tag} envoyé par Bird à ${to}`);
    else console.error(`[mailer] échec Bird (${tag}) :`, resultat.detail);
    return resultat;
  }

  const tx = choix.fournisseur === "smtp" ? getTransporter() : null;
  if (!tx) {
    // Aucun fournisseur utilisable. On le dit, et on ne livre pas — plutôt que
    // de publier le code dans les journaux en prétendant que c'est un repli.
    const raison = choix.raison ?? "SMTP non configuré";
    console.error(`[mailer] ${raison} : aucun envoi possible.`);
    return { remis: false, detail: raison };
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
