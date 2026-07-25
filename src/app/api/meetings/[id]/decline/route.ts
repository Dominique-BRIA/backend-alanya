import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/meetings/:id/decline — décline l'invitation (status = 2).
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const participant = await prisma.meetingParticipant.findUnique({
    where: {
      idMeeting_IDparticipant: { idMeeting: id, IDparticipant: userId },
    },
  });
  if (!participant) {
    return fail("Vous n'êtes pas invité à cette réunion", 404, "NOT_FOUND");
  }

  await prisma.meetingParticipant.update({
    where: { ID: participant.ID },
    data: { status: 2, connecte: 0 }, // 2 = décliné
  });

  return ok({ message: "Invitation déclinée", idMeeting: id });
});
