import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/meetings/:id — détail d'une réunion avec tous les participants.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: {
      organiser: {  },
      participants: {
        include: { user: {  } },
      },
    },
  });

  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");

  // Vérifier que l'utilisateur est l'organisateur ou un participant
  const isOrganiser = meeting.idOrganiser === userId;
  const isParticipant = meeting.participants.some(
    (p) => p.IDparticipant === userId,
  );
  if (!isOrganiser && !isParticipant) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }

  return ok({
    idMeeting: meeting.idMeeting,
    objet: meeting.objet,
    type_media: meeting.type_media,
    room: meeting.room,
    isEnd: meeting.isEnd,
    start_time: meeting.start_time,
    duree: meeting.duree,
    organiser: {
      id: meeting.organiser.id,
      pseudo: meeting.organiser.pseudo ?? null,
      publicNumber: meeting.organiser.publicNumber,
      avatarUrl: meeting.organiser.avatarUrl ?? null,
    },
    participants: meeting.participants.map((p) => ({
      ID: p.ID,
      IDparticipant: p.IDparticipant,
      pseudo: p.user.pseudo ?? null,
      publicNumber: p.user.publicNumber,
      avatarUrl: p.user.avatarUrl ?? null,
      status: p.status,
      connecte: p.connecte,
      start_time: p.start_time,
      duree: p.duree,
    })),
    isOrganiser,
  });
});
