import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/calls/:id/end — termine un appel en cours ou annule une sonnerie.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");

  const c = part.call;
  if (c.status === "ENDED" || c.status === "REJECTED") {
    return ok({ id: c.id, status: c.status });
  }

  const now = new Date();
  let status = "ENDED";
  if (c.status === "RINGING" && c.initiatorId !== userId) status = "MISSED";
  if (c.status === "RINGING" && c.initiatorId === userId) status = "ENDED";

  const updated = await prisma.call.update({
    where: { id },
    data: { status: status as "ENDED" | "MISSED", endedAt: now },
  });
  // Marque TOUS les participants comme sortis (pas seulement le demandeur),
  // pour éviter des CallParticipant orphelins avec leftAt = null.
  await prisma.callParticipant.updateMany({
    where: { callId: id, leftAt: null },
    data: { leftAt: now },
  });

  return ok({ id: updated.id, status: updated.status, endedAt: updated.endedAt });
});
