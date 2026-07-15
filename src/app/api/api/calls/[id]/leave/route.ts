import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/calls/:id/leave — quitte un appel de groupe sans le terminer pour les autres.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: { include: { participants: true } } },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");
  if (part.call.initiatorId === userId) {
    return fail("L'initiateur doit utiliser /end pour raccrocher le groupe", 400, "BAD_STATE");
  }
  if (part.call.status !== "ONGOING" && part.call.status !== "RINGING") {
    return fail("Appel non actif", 409, "BAD_STATE");
  }

  const now = new Date();
  await prisma.callParticipant.update({
    where: { callId_userId: { callId: id, userId } },
    data: { leftAt: now },
  });

  // Re-query depuis la base pour éviter une race condition avec le snapshot en mémoire.
  const stillActiveCount = await prisma.callParticipant.count({
    where: { callId: id, joinedAt: { not: null }, leftAt: null },
  });

  // Plus personne en ligne : on clôture l'appel.
  if (stillActiveCount === 0) {
    await prisma.call.update({
      where: { id },
      data: { status: "ENDED", endedAt: now },
    });
  }

  return ok({ id, left: true, callEnded: stillActiveCount === 0 });
});
