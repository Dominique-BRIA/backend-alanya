import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// DELETE /api/conversations/:id/delete — supprime une conversation pour l'utilisateur.
// Supprime les messages, médias, participants et la conversation elle-même.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  // Vérifie que l'utilisateur est participant
  const participant = await prisma.participant.findUnique({
    where: { convId_userId: { convId, userId } },
  });
  if (!participant) return fail("Conversation introuvable", 404, "NOT_FOUND");

  // Supprime les messages et leurs médias
  await prisma.mediaFile.deleteMany({ where: { message: { convId } } });
  await prisma.messageHide.deleteMany({ where: { message: { convId } } });
  await prisma.message.deleteMany({ where: { convId } });

  // Supprime les participants
  await prisma.participant.deleteMany({ where: { convId } });

  // Supprime la conversation
  await prisma.conversation.delete({ where: { id: convId } });

  return ok({ message: "Conversation supprimée", id: convId });
});
