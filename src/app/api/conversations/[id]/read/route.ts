import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// POST /api/conversations/:id/read — marque la conversation comme lue.
// Met à jour le pointeur de lecture et passe les messages reçus en READ.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const now = new Date();
  // Toujours mettre à jour le pointeur de lecture (non-lus).
  await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { lastReadAt: now, unreadCount: 0 },
  });

  // Confidentialité : ne passe les messages en READ que si l'utilisateur
  // envoie les confirmations de lecture (sinon l'expéditeur ne les verra pas).
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { readReceipts: true },
  });
  if (me && me.readReceipts !== 0) {
    await prisma.message.updateMany({
      where: { convId, senderId: { not: userId }, status: { not: "READ" } },
      data: { status: "READ" },
    });
  }

  return ok({ message: "Conversation marquée comme lue", readAt: now });
});
