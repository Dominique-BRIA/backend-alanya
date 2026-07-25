import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// GET /api/conversations/:id/pinned — message épinglé courant (ou null).
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      select: { pinnedMessageId: true },
    });
    const pinnedId = conv?.pinnedMessageId ?? null;
    if (!pinnedId) return ok({ pinnedMessageId: null, message: null });

    const m = await prisma.message.findUnique({
      where: { id: pinnedId },
      select: { id: true, senderId: true, content: true, type: true, deletedAt: true },
    });
    if (!m || m.deletedAt) return ok({ pinnedMessageId: null, message: null });

    return ok({
      pinnedMessageId: m.id,
      message: { id: m.id, senderId: m.senderId, content: m.content, type: m.type },
    });
  },
);
