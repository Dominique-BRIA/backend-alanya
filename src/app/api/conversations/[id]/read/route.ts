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
  await prisma.$transaction([
    prisma.participant.update({
      where: { convId_userId: { convId, userId } },
      data: { lastReadAt: now },
    }),
    prisma.message.updateMany({
      where: { convId, senderId: { not: userId }, status: { not: "READ" } },
      data: { status: "READ" },
    }),
  ]);

  return ok({ message: "Conversation marquée comme lue", readAt: now });
});
