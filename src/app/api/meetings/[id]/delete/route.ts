import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// DELETE /api/meetings/:id/delete — supprime une réunion terminée.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const idMeeting = Number((await ctx.params).id);
  if (isNaN(idMeeting) || idMeeting <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");

  // Seul l'organisateur peut supprimer
  if (meeting.idOrganiser !== userId) {
    return fail("Seul l'organisateur peut supprimer la réunion", 403, "FORBIDDEN");
  }

  // Supprime les participants et la réunion
  await prisma.meetingParticipant.deleteMany({ where: { idMeeting } });
  await prisma.meeting.delete({ where: { idMeeting } });

  return ok({ message: "Réunion supprimée", idMeeting });
});
