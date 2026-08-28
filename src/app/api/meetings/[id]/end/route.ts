import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { previensLaSalle } from "@/lib/salle-temps-reel";

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

  /*
   * TERMINER UNE RÉUNION LE DISAIT À LA BASE, PAS AUX GENS.
   *
   * `isEnd` passait à 1 et les participants étaient marqués déconnectés — mais
   * aucun message ne partait. Ceux qui étaient DANS la salle continuaient de
   * filmer et de s'entendre, sur une réunion officiellement close : le maillage
   * WebRTC vit entre les navigateurs et ne consulte pas la base. Ils ne
   * l'apprenaient qu'en quittant d'eux-mêmes.
   *
   * On ne passe PAS `exclure: userId` : l'organisateur peut avoir un second
   * appareil encore en salle, et celui-là n'a rien demandé.
   */
  await previensLaSalle({ meetingId: id, type: "meeting_ended" });

  return ok({ message: "Réunion terminée", idMeeting: id });
});
