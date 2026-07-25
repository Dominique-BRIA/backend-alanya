import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// POST /api/conversations/:id/pin-message — body { messageId: string | null }
// Épingle (ou détache si null) un message pour toute la conversation.
// Repli REST ; la diffusion temps réel est gérée par le serveur WS.
export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    const { messageId } = await req.json();
    const pin = typeof messageId === "string" ? messageId : null;

    if (pin) {
      const m = await prisma.message.findFirst({
        where: { id: pin, convId },
        select: { id: true },
      });
      if (!m) return fail("Message introuvable", 404, "NOT_FOUND");
    }

    await prisma.conversation.update({
      where: { id: convId },
      data: { pinnedMessageId: pin },
    });
    return ok({ pinnedMessageId: pin });
  },
);
