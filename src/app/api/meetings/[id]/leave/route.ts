import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/meetings/:id/leave — le participant quitte la réunion.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const participant = await prisma.meetingParticipant.findUnique({
    where: {
      idMeeting_IDparticipant: { idMeeting: id, IDparticipant: userId },
    },
  });

  if (!participant) return fail("Vous ne participez pas à cette réunion", 404, "NOT_FOUND");
  if (participant.connecte === 0) return fail("Vous êtes déjà déconnecté", 400, "ALREADY_LEFT");

  // Calculer la durée de participation
  const now = new Date();
  const duree = participant.start_time
    ? Math.round((now.getTime() - participant.start_time.getTime()) / 1000)
    : null;

  await prisma.meetingParticipant.update({
    where: { ID: participant.ID },
    data: {
      connecte: 0,
      duree: duree ?? participant.duree,
    },
  });

  return ok({ message: "Vous avez quitté la réunion", idMeeting: id, duree });
});
