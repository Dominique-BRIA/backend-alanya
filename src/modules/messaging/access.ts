import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";

// Vérifie que l'utilisateur participe bien à la conversation.
export async function assertParticipant(convId: string, userId: string) {
  const participant = await prisma.participant.findUnique({
    where: { convId_userId: { convId, userId } },
  });
  if (!participant) throw new HttpError(403, "Vous ne participez pas à cette conversation", "FORBIDDEN");
  return participant;
}

/**
 * La conversation avec SOI-MÊME — le « Moi » de WhatsApp, pour se garder des
 * notes.
 *
 * 🔴 UN SEUL PARTICIPANT, et c'est la seule modélisation possible ici :
 * `conv_participants` porte un `@@unique([convId, userId])`, donc deux lignes
 * pour la même personne dans la même conversation sont interdites par la base.
 * L'appel naïf `findOrCreateDirectConversation(moi, moi)` aurait donc levé une
 * violation de contrainte à la création.
 *
 * ⚠️ Et il aurait fait pire AVANT d'échouer : sa recherche se résume à
 * « une conversation non-groupe contenant moi ET contenant moi », c'est-à-dire
 * **n'importe laquelle de mes conversations**. Elle aurait renvoyé celle de
 * quelqu'un d'autre, la première trouvée — « m'écrire à moi-même » aurait ouvert
 * la discussion d'un correspondant au hasard.
 *
 * La forme « un seul participant » est sûre : mesuré en production avant de
 * choisir, aucune conversation n'a cette forme (127 à deux participants, le
 * reste étant des groupes de 3 à 7). Rien d'existant ne peut donc être confondu
 * avec une conversation personnelle.
 *
 * `some` + `every` font le tri dans PostgreSQL : au moins un participant qui
 * soit moi, et aucun qui ne le soit pas. Combiné à l'unicité, cela désigne
 * exactement une conversation à un participant. `every` seul ne suffirait pas —
 * il est vrai d'une relation VIDE.
 */
export async function findOrCreateSelfConversation(userId: string) {
  const mienne = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      participants: { some: { userId }, every: { userId } },
    },
    include: { participants: true },
  });
  if (mienne) return mienne;

  return prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId }] },
    },
    include: { participants: true },
  });
}

// Retrouve (ou crée) la conversation directe entre deux utilisateurs.
export async function findOrCreateDirectConversation(userA: string, userB: string) {
  // Se parler à soi-même n'est pas un cas particulier du direct : c'est une
  // autre forme de conversation. Aiguillé ici pour que TOUS les appelants en
  // bénéficient, plutôt que chacun ait à y penser.
  if (userA === userB) return findOrCreateSelfConversation(userA);

  // Une conversation directe = non-groupe contenant exactement ces deux participants.
  const existing = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: userA } } },
        { participants: { some: { userId: userB } } },
      ],
    },
    include: { participants: true },
  });
  if (existing && existing.participants.length === 2) return existing;

  return prisma.conversation.create({
    data: {
      isGroup: false,
      participants: {
        create: [{ userId: userA }, { userId: userB }],
      },
    },
    include: { participants: true },
  });
}
