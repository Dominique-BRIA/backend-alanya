import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { clientIp } from "@/lib/rate-limit";
import { clientDepuisUserAgent, systemeDepuisUserAgent } from "@/lib/user-access";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { TYPE_COMPTE_AGENT } from "@/lib/collegues";

/**
 * LA CONNEXION WEB EN DEUX ÉTAPES (18/10/2026).
 *
 * 🔴 DEMANDE DU PATRON : « juste le user password, c'est pas solide ». Sur le
 * WEB, après le mot de passe, un code à six chiffres est envoyé dans
 * l'application Android du compte ; on le saisit dans le navigateur, et c'est
 * seulement alors que la session est délivrée.
 *
 *  - au CHOIX pour un particulier (`User.deuxEtapes`, réglé dans l'application) ;
 *  - IMPOSÉE à un agent d'entreprise (type 2) : il est « censé avoir
 *    l'application sur le téléphone ».
 *
 * ⚠️ LA CONNEXION SUR LE TÉLÉPHONE N'EST PAS CONCERNÉE : c'est lui qui reçoit
 * le code, et il est déjà lié au compte (« un compte, un téléphone »).
 *
 * ⚠️ LE CODE N'EST JAMAIS GARDÉ EN CLAIR : seule son empreinte SHA-256, comparée
 * à temps constant. Cinq minutes, cinq essais, puis le défi est perdu.
 */

export const DUREE_DEFI_MS = 5 * 60_000;
export const ESSAIS_MAX = 5;

type CompteDeuxEtapes = { typeCompte: number; deuxEtapes: boolean };

/** La connexion web de ce compte demande-t-elle un code ? */
export function deuxEtapesExigee(u: CompteDeuxEtapes): boolean {
  return deuxEtapesImposee(u) || u.deuxEtapes;
}

/** Imposée par le type de compte — l'utilisateur ne peut pas l'éteindre. */
export function deuxEtapesImposee(u: { typeCompte: number }): boolean {
  return u.typeCompte === TYPE_COMPTE_AGENT;
}

function empreinte(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export type ResultatDefi =
  | { ok: true; defiId: string }
  | { ok: false; code: "SANS_APPLICATION" };

/**
 * Crée un défi et envoie son code dans l'application : trame temps réel aux
 * appareils connectés, et notification pour un téléphone en veille.
 *
 * ⚠️ AUCUNE APPLICATION ENREGISTRÉE (aucun jeton de notification) : le code
 * n'arriverait nulle part. On refuse plutôt que de laisser attendre un code
 * qui ne viendra jamais.
 */
export async function lancerDefi(userId: string, req: NextRequest): Promise<ResultatDefi> {
  const appareils = await prisma.pushDevice.count({ where: { userId } });
  if (appareils === 0) return { ok: false, code: "SANS_APPLICATION" };

  // Un seul défi vivant par compte : redemander un code périme le précédent.
  await prisma.defiConnexion.updateMany({
    where: { userId, statut: "attente" },
    data: { statut: "epuise" },
  });

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const ua = req.headers.get("user-agent");
  const navigateur = `${clientDepuisUserAgent(ua)} · ${systemeDepuisUserAgent(ua)}`.slice(0, 200);
  const ip = clientIp(req).slice(0, 64);
  const expireLe = new Date(Date.now() + DUREE_DEFI_MS);
  const defi = await prisma.defiConnexion.create({
    data: { userId, empreinte: empreinte(code), navigateur, ip, expireLe },
    select: { id: true },
  });

  // L'application ouverte : une fenêtre avec le code, et « Ce n'est pas moi ».
  await previensDesPersonnes({
    personnes: [userId],
    type: "connexion_web_code",
    donnees: { defiId: defi.id, code, navigateur, ip, expireLe: expireLe.toISOString() },
  });

  // L'application en veille : une notification qui porte le code.
  try {
    const { sendPushToUser } = await import("@/../push.mjs");
    await sendPushToUser(prisma, userId, {
      title: "Code de connexion web",
      body: `${code} — à saisir dans le navigateur (${navigateur}). Ce n'est pas vous ? Ignorez ce code.`,
      data: { type: "connexion_web_code", defiId: defi.id, code, navigateur },
    });
  } catch {
    // La trame temps réel a peut-être suffi ; le navigateur pourra redemander.
  }
  return { ok: true, defiId: defi.id };
}

export type ResultatVerification =
  | { ok: true; userId: string }
  | { ok: false; code: "DEFI_INCONNU" | "DEFI_EXPIRE" | "DEFI_REFUSE" | "CODE_FAUX"; restants?: number };

/** Vérifie le code saisi dans le navigateur. Un défi ne sert qu'une fois. */
export async function verifierDefi(defiId: string, code: string): Promise<ResultatVerification> {
  const defi = await prisma.defiConnexion.findUnique({ where: { id: defiId } });
  if (!defi) return { ok: false, code: "DEFI_INCONNU" };
  if (defi.statut === "refuse") return { ok: false, code: "DEFI_REFUSE" };
  if (defi.statut !== "attente" || defi.expireLe.getTime() < Date.now()) {
    return { ok: false, code: "DEFI_EXPIRE" };
  }

  const propose = Buffer.from(empreinte(code.replace(/\s/g, "")), "hex");
  const attendu = Buffer.from(defi.empreinte, "hex");
  const bon = propose.length === attendu.length && timingSafeEqual(propose, attendu);
  if (!bon) {
    const tentatives = defi.tentatives + 1;
    await prisma.defiConnexion.update({
      where: { id: defiId },
      data: { tentatives, statut: tentatives >= ESSAIS_MAX ? "epuise" : "attente" },
    });
    return tentatives >= ESSAIS_MAX
      ? { ok: false, code: "DEFI_EXPIRE" }
      : { ok: false, code: "CODE_FAUX", restants: ESSAIS_MAX - tentatives };
  }

  // Valide une seule fois, même si deux requêtes arrivent ensemble.
  const { count } = await prisma.defiConnexion.updateMany({
    where: { id: defiId, statut: "attente" },
    data: { statut: "valide" },
  });
  if (count === 0) return { ok: false, code: "DEFI_EXPIRE" };
  return { ok: true, userId: defi.userId };
}

/** « Ce n'est pas moi » : depuis l'application, le défi est perdu. */
export async function refuserDefi(userId: string, defiId: string): Promise<boolean> {
  const { count } = await prisma.defiConnexion.updateMany({
    where: { id: defiId, userId, statut: "attente" },
    data: { statut: "refuse" },
  });
  return count > 0;
}
