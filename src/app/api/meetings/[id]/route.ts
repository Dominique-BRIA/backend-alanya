import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// GET /api/meetings/:id — détail d'une réunion avec tous les participants.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: {
      organiser: true,
      participants: {
        include: { user: true },
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
    invitationAuto: meeting.invitationAuto === 1,
    room: meeting.room,
    isEnd: meeting.isEnd,
    start_time: meeting.start_time,
    duree: meeting.duree,
    organiser: {
      id: meeting.organiser.id,
      pseudo: nomAffichage(meeting.organiser),
      publicNumber: meeting.organiser.publicNumber,
      avatarUrl: avatarPublicUrl(meeting.organiser.avatarUrl ?? null),
    },
    participants: meeting.participants.map((p) => ({
      ID: p.ID,
      IDparticipant: p.IDparticipant,
      pseudo: nomAffichage(p.user),
      publicNumber: p.user.publicNumber,
      avatarUrl: avatarPublicUrl(p.user.avatarUrl ?? null),
      status: p.status,
      connecte: p.connecte,
      start_time: p.start_time,
      duree: p.duree,
    })),
    isOrganiser,
  });
});
