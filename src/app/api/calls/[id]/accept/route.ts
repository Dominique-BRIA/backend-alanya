import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { activeCallParticipants, conversationMeta } from "@/lib/calls";

// POST /api/calls/:id/accept — accepte / rejoint un appel (direct ou groupe).
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");
  if (part.call.initiatorId === userId) return fail("L'appelant ne peut pas accepter", 400, "BAD_STATE");
  if (part.joinedAt && !part.leftAt) return fail("Déjà dans l'appel", 409, "ALREADY_JOINED");

  const { isGroup } = await conversationMeta(part.call.convId);
  const status = part.call.status;
  if (!isGroup && status !== "RINGING") return fail("Appel non disponible", 409, "BAD_STATE");
  if (isGroup && (status === "ENDED" || status === "REJECTED")) {
    return fail("Appel terminé", 409, "BAD_STATE");
  }

  const now = new Date();
  if (status === "RINGING") {
    await prisma.call.update({
      where: { id },
      data: { status: "ONGOING", answeredAt: now },
    });
  }
  await prisma.callParticipant.update({
    where: { callId_userId: { callId: id, userId } },
    data: { joinedAt: now, leftAt: null },
  });

  const meta = await conversationMeta(part.call.convId);
  const activeParticipants = await activeCallParticipants(id);

  return ok({
    id,
    status: "ONGOING",
    answeredAt: now,
    isGroup: meta.isGroup,
    groupName: meta.groupName,
    activeParticipants,
  });
});
