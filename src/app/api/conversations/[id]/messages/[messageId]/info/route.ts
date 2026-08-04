import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";
import { nomAffichage } from "@/lib/display-name.mjs";

// GET /api/conversations/:id/messages/:messageId/info — accusés « lu » par membre.
// Dérivé de Participant.lastReadAt (lu si lastReadAt >= date du message).
// Réservé à l'expéditeur du message (comme WhatsApp).
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const message = await prisma.message.findFirst({
      where: { id: messageId, convId },
      select: { id: true, senderId: true, createdAt: true },
    });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");
    if (message.senderId !== userId) {
      return fail("Infos réservées à vos propres messages", 403, "FORBIDDEN");
    }

    const participants = await prisma.participant.findMany({
      where: { convId, userId: { not: userId } },
      select: {
        userId: true,
        lastReadAt: true,
        user: { select: { nom: true, pseudo: true, publicNumber: true } },
      },
    });

    const members = participants.map((p) => {
      const read = p.lastReadAt != null && p.lastReadAt >= message.createdAt;
      return {
        userId: p.userId,
        name: nomAffichage(p.user),
        read,
        readAt: read ? p.lastReadAt : null,
      };
    });

    return ok({ messageId: message.id, createdAt: message.createdAt, members });
  },
);
