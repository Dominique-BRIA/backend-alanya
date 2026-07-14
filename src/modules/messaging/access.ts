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

// Retrouve (ou crée) la conversation directe entre deux utilisateurs.
export async function findOrCreateDirectConversation(userA: string, userB: string) {
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
