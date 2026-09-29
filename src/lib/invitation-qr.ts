import { randomBytes } from "node:crypto";

/**
 * LES INVITATIONS À USAGE UNIQUE (QR code partageable, 15 minutes).
 *
 * Les règles vivent ici ; les routes `/api/invitations/…` ne font que les
 * appliquer. Table : `invitation_qr` (prisma/manual/2026-09_invitation_qr.sql).
 *
 * Décisions du user (29/09/2026) :
 *   · valable 15 minutes, utilisable UNE fois ;
 *   · le lien ne révèle pas l'Alanya ID du créateur ;
 *   · l'utiliser ajoute les deux personnes l'une chez l'autre ;
 *   · pas de plafond total, seulement un frein anti-robot (30 par heure) ;
 *   · plusieurs invitations actives à la fois, pas d'annulation.
 */

export const DUREE_INVITATION_MS = 15 * 60_000;

/** Frein anti-robot : un humain n'atteint jamais 30 QR en une heure. */
export const INVITATIONS_PAR_HEURE = 30;

/**
 * Une invitation périmée est supprimée un jour après son expiration (ménage
 * fait à chaque création, sans tâche planifiée). Le délai laisse le temps de
 * répondre « expirée » plutôt qu'« introuvable » à qui clique en retard.
 */
export const GARDE_APRES_EXPIRATION_MS = 24 * 3_600_000;

/**
 * Forme d'un jeton : base64url. Le serveur émet 22 caractères (128 bits) ; la
 * borne haute suit la colonne VARCHAR(43). Refuser d'emblée ce qui n'en est
 * pas un évite une lecture en base pour rien.
 */
export const JETON_REGEX = /^[A-Za-z0-9_-]{16,43}$/;

/**
 * 128 bits aléatoires : deviner un jeton valide pendant ses 15 minutes de vie
 * est hors de portée, sans limite de tentatives à tenir.
 */
export function nouveauJeton(): string {
  return randomBytes(16).toString("base64url");
}

/** Même hôte que les QR de profil et que le manifeste Android. */
export function lienInvitation(jeton: string): string {
  return `https://alanyavox.com/i/${jeton}`;
}

export type EtatInvitation = "valide" | "expiree" | "utilisee";

/**
 * « Utilisée » l'emporte sur « expirée » : quelqu'un qui a déjà servi
 * l'invitation doit l'apprendre, même si l'heure est passée depuis.
 */
export function etatInvitation(
  inv: { expireLe: Date; utiliseeLe: Date | null },
  maintenant: Date = new Date(),
): EtatInvitation {
  if (inv.utiliseeLe) return "utilisee";
  if (inv.expireLe.getTime() <= maintenant.getTime()) return "expiree";
  return "valide";
}
