import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// POST /api/conversations/:id/disappearing — body { seconds: number }
// Règle le minuteur des messages éphémères (0 = désactivé). Repli REST ;
// la diffusion temps réel est gérée par le serveur WS.
export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    const { seconds } = await req.json();
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;

    await prisma.conversation.update({
      where: { id: convId },
      data: { disappearingSeconds: value },
    });
    return ok({ disappearingSeconds: value });
  },
);
