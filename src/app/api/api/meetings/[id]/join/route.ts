import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/meetings/:id/join — accepte l'invitation et marque le participant comme connecté.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.isEnd === 1) return fail("Cette réunion est terminée", 400, "ENDED");

  const participant = await prisma.meetingParticipant.findUnique({
    where: {
      idMeeting_IDparticipant: { idMeeting: id, IDparticipant: userId },
    },
  });

  // Si l'utilisateur n'est pas encore dans la liste, l'ajouter (l'organisateur peut rejoindre directement)
  if (!participant) {
    // Vérifier que c'est bien l'organisateur ou un utilisateur invité
    if (meeting.idOrganiser !== userId) {
      return fail("Vous n'êtes pas invité à cette réunion", 403, "FORBIDDEN");
    }
    // L'organisateur rejoint : créer son entrée participant
    await prisma.meetingParticipant.create({
      data: {
        idMeeting: id,
        IDparticipant: userId,
        status: 1,
        connecte: 1,
        start_time: new Date(),
      },
    });
  } else {
    await prisma.meetingParticipant.update({
      where: { ID: participant.ID },
      data: {
        status: 1, // accepté
        connecte: 1,
        start_time: new Date(),
      },
    });
  }

  return ok({ message: "Connecté à la réunion", idMeeting: id });
});
