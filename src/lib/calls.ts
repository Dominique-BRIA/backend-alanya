import { prisma } from "@/lib/prisma";

export async function conversationMeta(convId: string | null) {
  if (!convId) return { isGroup: false, groupName: null as string | null, memberCount: 2 };
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  return {
    isGroup: conv?.isGroup ?? false,
    groupName: conv?.name ?? null,
    memberCount: conv?.participants.length ?? 2,
  };
}

/// Délai au bout duquel un appel qui sonne est considéré sans réponse.
///
/// 90 s et non 2 min : c'est la valeur du minuteur Telecom côté Android. Quand
/// les deux divergent, l'appel disparaît de l'écran du téléphone avant que le
/// serveur ne le clôture, et l'utilisateur voit une sonnerie fantôme. Toute
/// modification ici doit être répercutée côté mobile.
export const DELAI_SANS_REPONSE_MS = 90 * 1000;

export type LibelleAppel = {
  preciseStatus: string;
  detail: string | null;
  isFailed: boolean;
  colorHint: "danger" | "positive" | "info" | "neutral";
};

/**
 * Formule un statut d'appel DU POINT DE VUE d'un destinataire donné.
 *
 * C'est le seul endroit où la nuance appelant/appelé est décidée. Le client se
 * contente d'afficher : il n'a plus à déduire quoi que ce soit de `durationSec`
 * ou du statut brut, ce qui produisait « Rejeté » des deux côtés d'un même
 * appel.
 *
 * La règle, telle que définie : B ne décroche pas → « sans réponse » chez A,
 * « manqué » chez B. B refuse → « refusé » chez A, « rejeté » chez B.
 */
export function libelleAppel(
  status: string,
  isOutgoing: boolean,
  durationSec: number | null,
): LibelleAppel {
  // `preciseStatus` est le libellé complet des listes (« Appel manqué ») ;
  // `detail` est sa forme courte pour la bulle du fil, où le type d'appel est
  // déjà écrit au-dessus (« Appel vocal entrant » / « Manqué »).
  const echec = (preciseStatus: string, detail: string): LibelleAppel => ({
    preciseStatus,
    detail,
    isFailed: true,
    colorHint: "danger",
  });

  switch (status) {
    case "REJECTED":
      return isOutgoing
        ? echec("Appel refusé", "Refusé")
        : echec("Appel rejeté", "Rejeté");

    // MISSED est l'ancienne écriture de NO_ANSWER : même fait, même rendu.
    case "NO_ANSWER":
    case "MISSED":
      return isOutgoing
        ? echec("Appel sans réponse", "Sans réponse")
        : echec("Appel manqué", "Manqué");

    case "BUSY":
      // Côté appelé, l'appel n'a jamais sonné : il était en ligne. Le présenter
      // comme « manqué » est ce qui décrit le mieux ce qu'il a vécu.
      return isOutgoing
        ? echec("Occupé", "Occupé")
        : echec("Appel manqué", "Manqué");

    case "RINGING":
      return { preciseStatus: "Sonnerie", detail: "En cours", isFailed: false, colorHint: "neutral" };

    case "ONGOING":
      return { preciseStatus: "En cours", detail: "En cours", isFailed: false, colorHint: "neutral" };

    case "ENDED":
      // Un ENDED sans durée est un appel que personne n'a décroché : c'est
      // l'ancien comportement de `end/route.ts`, encore présent dans les
      // données. Le nouveau code écrit NO_ANSWER dans ce cas.
      if (durationSec === null || durationSec <= 0) {
        return isOutgoing
          ? echec("Appel sans réponse", "Sans réponse")
          : echec("Appel manqué", "Manqué");
      }
      return {
        preciseStatus: isOutgoing ? "Appel sortant" : "Appel entrant",
        detail: "Répondu",
        isFailed: false,
        colorHint: isOutgoing ? "positive" : "info",
      };

    default:
      return { preciseStatus: status, detail: null, isFailed: false, colorHint: "neutral" };
  }
}

/**
 * L'utilisateur est-il déjà engagé dans un appel ?
 *
 * ⚠️ `joinedAt: { not: null }` est volontairement ABSENT ici, à la différence du
 * contrôle qui existait pour l'appelant. Un appelé dont le téléphone sonne a
 * `joinedAt` à nul tant qu'il n'a pas décroché : exiger `joinedAt` le déclarait
 * donc libre, et un second appelant pouvait le faire sonner par-dessus le
 * premier. C'est le trou qui laissait passer les doubles appels.
 */
export async function estOccupe(userId: string) {
  return prisma.callParticipant.findFirst({
    where: {
      userId,
      leftAt: null,
      call: { status: { in: ["RINGING", "ONGOING"] } },
    },
    select: { callId: true },
  });
}

export async function activeCallParticipants(callId: string) {
  const parts = await prisma.callParticipant.findMany({
    where: { callId, joinedAt: { not: null }, leftAt: null },
    include: { user: true },
  });
  return parts.map((p) => ({
    userId: p.userId,
    displayName: p.user.pseudo ?? p.user.publicNumber,
  }));
}
