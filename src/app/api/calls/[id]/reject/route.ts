import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { conversationMeta } from "@/lib/calls";

// POST /api/calls/:id/reject — refuse un appel (direct) ou décline un appel de groupe.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");
  if (part.call.status !== "RINGING" && part.call.status !== "ONGOING") {
    return fail("Appel non disponible", 409, "BAD_STATE");
  }

  const { isGroup } = await conversationMeta(part.call.convId);
  const now = new Date();

  if (isGroup) {
    await prisma.callParticipant.update({
      where: { callId_userId: { callId: id, userId } },
      data: { leftAt: now },
    });
    return ok({ id, declined: true, isGroup: true });
  }

  const updated = await prisma.call.update({
    where: { id },
    data: { status: "REJECTED", endedAt: now },
  });

  return ok({ id: updated.id, status: updated.status, declined: true, isGroup: false });
});
