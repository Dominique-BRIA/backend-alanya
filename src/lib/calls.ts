import { prisma } from "@/lib/prisma";
import { nomAffichage } from "./display-name.mjs";

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

// Les règles de libellé vivent dans `call-labels.mjs` et sont seulement
// réexportées ici avec leurs types. La raison est expliquée en tête de ce
// fichier-là : `ws-server.mjs` tourne dans un process Node séparé, hors de la
// compilation Next.js, et ne peut pas importer de TypeScript. Une seule
// implémentation pour les deux, sinon le formalisme finirait par diverger entre
// l'historique et le temps réel.
export {
  DELAI_SANS_REPONSE_MS,
  libelleAppel,
  serialiseAppelPour,
  STATUTS_TERMINAUX,
} from "./call-labels.mjs";

export type LibelleAppel = {
  preciseStatus: string;
  detail: string | null;
  isFailed: boolean;
  colorHint: "danger" | "positive" | "info" | "neutral";
};

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
    displayName: nomAffichage(p.user) ?? p.user.publicNumber,
    // L'avatar manquait, et c'est le seul endroit d'où le client peut le
    // tenir quand il décroche APPLICATION FERMÉE : il n'a alors pas reçu
    // l'événement WebSocket d'appel entrant, qui le portait jusqu'ici. Son
    // écran d'appel restait donc sans photo, alors qu'il en affiche une quand
    // l'application était ouverte.
    avatarUrl: p.user.avatarUrl ?? null,
  }));
}
