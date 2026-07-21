import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/meetings/:id/end — termine la réunion (organisateur uniquement).
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: { participants: true },
  });

  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.idOrganiser !== userId) {
    return fail("Seul l'organisateur peut terminer la réunion", 403, "FORBIDDEN");
  }
  if (meeting.isEnd === 1) return fail("Cette réunion est déjà terminée", 400, "ALREADY_ENDED");

  // Marquer la réunion comme terminée
  await prisma.meeting.update({
    where: { idMeeting: id },
    data: { isEnd: 1 },
  });

  // Déconnecter tous les participants encore connectés et calculer leur durée
  const now = new Date();
  for (const p of meeting.participants) {
    if (p.connecte === 1) {
      const duree = p.start_time
        ? Math.round((now.getTime() - p.start_time.getTime()) / 1000)
        : p.duree;
      await prisma.meetingParticipant.update({
        where: { ID: p.ID },
        data: { connecte: 0, duree },
      });
    }
  }

  return ok({ message: "Réunion terminée", idMeeting: id });
});
