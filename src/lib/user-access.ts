import { type NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { clientIp } from "./rate-limit";

/**
 * Journal des connexions (table `userAccess` du référentiel équipe).
 *
 * À distinguer de la table `Appareil` :
 *  - `Appareil` est un REGISTRE — une ligne par appareil, mise à jour au fil de
 *    l'eau. Elle répond à « quels appareils ont accès à mon compte ? » ;
 *  - `userAccess` est un JOURNAL — une ligne par connexion, jamais modifiée.
 *    Elle répond à « quand et depuis où s'est-on connecté ? ».
 *
 * Les deux se recoupent en apparence, mais l'une se met à jour quand l'autre
 * s'empile : effacer un appareil du registre ne doit pas effacer l'historique
 * de ses connexions, sans quoi le journal perdrait tout intérêt.
 */

/** Valeur du référentiel quand l'information est absente. */
const INDEFINI = "INDEFINI";

/** Tronque à la taille de la colonne pour ne jamais faire échouer l'insertion. */
function borner(valeur: string | null | undefined, max: number): string {
  const v = (valeur ?? "").trim();
  return v.length === 0 ? INDEFINI : v.slice(0, max);
}

/**
 * Système d'exploitation deviné depuis l'en-tête `user-agent`.
 *
 * Volontairement grossier : il sert à distinguer les connexions dans une liste,
 * pas à faire de l'analyse d'audience. Stocker l'en-tête brut serait à la fois
 * illisible et inutilement bavard.
 */
export function systemeDepuisUserAgent(ua: string | null): string {
  if (!ua) return INDEFINI;
  if (/Windows NT 10/i.test(ua)) return "Windows 10/11";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android\s+([\d.]+)/i.test(ua)) {
    return `Android ${/Android\s+([\d.]+)/i.exec(ua)?.[1] ?? ""}`.trim();
  }
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS";
  if (/Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  if (/Dart\/|dart:io/i.test(ua)) return "Alanya mobile";
  return INDEFINI;
}

/** Navigateur ou client, deviné depuis l'en-tête `user-agent`. */
export function clientDepuisUserAgent(ua: string | null): string {
  if (!ua) return INDEFINI;
  if (/Dart\/|dart:io/i.test(ua)) return "Application Alanya";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return INDEFINI;
}

/**
 * Enregistre une connexion réussie.
 *
 * **N'échoue jamais bruyamment** : le journal ne doit pas empêcher un
 * utilisateur légitime de se connecter. Une erreur est journalisée côté
 * serveur, la connexion se poursuit.
 *
 * @param device libellé fourni par le client (facultatif) ; sinon deviné.
 */
export async function recordAccess(
  prisma: PrismaClient,
  opts: { userId: string; req: NextRequest; device?: string | null },
): Promise<void> {
  try {
    const ua = opts.req.headers.get("user-agent");
    await prisma.userAccess.create({
      data: {
        alanyaId: opts.userId,
        device: borner(opts.device ?? clientDepuisUserAgent(ua), 255),
        ipAdress: borner(clientIp(opts.req), 255),
        osSystem: borner(systemeDepuisUserAgent(ua), 255),
      },
    });
  } catch (err) {
    console.error("[userAccess] enregistrement impossible :", err);
  }
}
