import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// POST /api/conversations/:id/messages/:messageId/star — body { starred: boolean }
// Ajoute/retire le message des favoris de l'utilisateur (favori privé).
export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const { starred } = await req.json();

    const message = await prisma.message.findFirst({
      where: { id: messageId, convId },
      select: { id: true },
    });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");

    if (starred) {
      await prisma.messageStar.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId },
        update: {},
      });
    } else {
      await prisma.messageStar.deleteMany({ where: { messageId, userId } });
    }
    return ok({ messageId, starred: Boolean(starred) });
  },
);
