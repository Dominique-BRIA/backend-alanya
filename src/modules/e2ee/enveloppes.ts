import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";

/**
 * LES RÈGLES DU DÉPÔT D'ENVELOPPES — partagées par `POST /api/e2ee/enveloppes`
 * et par la PUBLICATION DIFFÉRÉE d'un envoi en morceaux (10/10/2026).
 *
 * 🔴 EXTRAITES, PAS RECOPIÉES. La publication différée dépose les enveloppes
 * qu'un appareil a préparées, parfois des heures plus tôt, application fermée
 * depuis. Elle doit appliquer les MÊMES contrôles que la route : forme, taille,
 * destinataires membres, blocage. Une copie aurait perdu l'un d'eux — c'est
 * l'histoire de `creerMessage` et de l'API v1.
 *
 * ⚠️ `corps` RESTE OPAQUE : ce module ne l'inspecte pas, ne le journalise pas.
 */

/**
 * Plafond d'un dépôt.
 *
 * ⚠️ PORTÉ DE 40 À 1 000 LE 09/10/2026 pour les GROUPES chiffrés : un
 * administrateur distribue le trousseau à CHAQUE appareil de CHAQUE membre
 * (cours, chapitre 31). Un groupe de 300 personnes à deux appareils, c'est
 * 600 enveloppes d'un coup. Un message de tête-à-tête, lui, en compte toujours
 * quelques-unes.
 */
export const ENVELOPPES_MAX = 1000;

/** Taille maximale d'un chiffré, en caractères base64 (~48 Ko utiles). */
export const CORPS_MAX = 64 * 1024;

export interface EnveloppeLue {
  destinataireId: string;
  destinataireDevice: number;
  type: number;
  corps: string;
}

/**
 * Lit les enveloppes d'une requête. Rend un code d'erreur plutôt que de lever :
 * chaque appelant a sa propre façon de répondre.
 */
export function lireEnveloppes(brut: unknown): EnveloppeLue[] | "AUCUNE" | "TROP" | "MAL_FORMEE" {
  const brutes = Array.isArray(brut) ? brut : [];
  if (brutes.length === 0) return "AUCUNE";
  if (brutes.length > ENVELOPPES_MAX) return "TROP";
  const lues: EnveloppeLue[] = [];
  for (const b of brutes) {
    const e = (b ?? {}) as Record<string, unknown>;
    const ok =
      typeof e.destinataireId === "string" &&
      e.destinataireId !== "" &&
      typeof e.destinataireDevice === "number" &&
      Number.isInteger(e.destinataireDevice) &&
      // 3 = PreKeyWhisperMessage (ouvre la session), 1 = WhisperMessage. Les deux seules valeurs
      // que la bibliothèque du client sait produire et relire.
      (e.type === 1 || e.type === 3) &&
      typeof e.corps === "string" &&
      e.corps.length > 0 &&
      e.corps.length <= CORPS_MAX;
    if (!ok) return "MAL_FORMEE";
    lues.push({
      destinataireId: e.destinataireId as string,
      destinataireDevice: e.destinataireDevice as number,
      type: e.type as number,
      corps: e.corps as string,
    });
  }
  return lues;
}

/**
 * Un destinataire n'est-il PAS membre actif de la conversation ? Sans ce
 * contrôle, on se servirait du dépôt pour écrire chez n'importe qui.
 */
export async function destinataireEtranger(convId: string, lues: EnveloppeLue[]): Promise<boolean> {
  const membres = await prisma.participant.findMany({
    where: { convId, ...MEMBRE_ACTIF },
    select: { userId: true },
  });
  const autorises = new Set(membres.map((m) => m.userId));
  return lues.some((e) => !autorises.has(e.destinataireId));
}

/**
 * Un blocage, dans un sens ou dans l'autre, entre l'expéditeur et l'un des
 * destinataires (lui-même exclu). À ne PAS appliquer en groupe : voir la route.
 */
export async function blocageAvec(expediteurId: string, lues: EnveloppeLue[]): Promise<boolean> {
  const autres = [...new Set(lues.map((e) => e.destinataireId))].filter((id) => id !== expediteurId);
  if (autres.length === 0) return false;
  const blocage = await prisma.blocked.findFirst({
    where: {
      OR: [
        { alanyaID: expediteurId, idCallerBlock: { in: autres } },
        { alanyaID: { in: autres }, idCallerBlock: expediteurId },
      ],
    },
    select: { idBlock: true },
  });
  return blocage !== null;
}

/** Écrit les enveloppes. Les contrôles ont eu lieu avant. */
export async function deposerEnveloppes(params: {
  convId: string;
  expediteurId: string;
  expediteurDevice: number;
  messageId: string | null;
  lues: EnveloppeLue[];
}): Promise<void> {
  await prisma.e2eeEnveloppe.createMany({
    data: params.lues.map((e) => ({
      convId: params.convId,
      expediteurId: params.expediteurId,
      expediteurDevice: params.expediteurDevice,
      destinataireId: e.destinataireId,
      destinataireDevice: e.destinataireDevice,
      type: e.type,
      corps: e.corps,
      messageId: params.messageId,
    })),
  });
}
