import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { moteurDeLaReunion } from "@/lib/moteur-reunion";
import { appareilSaitLeSfu } from "@/lib/sfu-salle";

/**
 * POST /api/meetings/:id/moteur — `{ moteur: "mesh" | "sfu" }` (07/11/2026).
 *
 * Le moteur de la réunion, fixé s'il ne l'est pas encore. L'application le
 * demande AVANT d'entrer (`meeting_join` par le socket), parce qu'elle
 * construit son moteur média avant : elle doit savoir lequel.
 *
 * Ne touche pas à la participation : c'est le socket qui inscrit et qui
 * tranche le plafond. Un appareil qui ne sait pas rejoindre le SFU reçoit
 * 409 `APP_A_METTRE_A_JOUR`.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    select: { isEnd: true, idOrganiser: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.isEnd === 1) return fail("Cette réunion est terminée", 400, "ENDED");
  if (meeting.idOrganiser !== userId) {
    const p = await prisma.meetingParticipant.findUnique({
      where: { idMeeting_IDparticipant: { idMeeting: id, IDparticipant: userId } },
      select: { ID: true },
    });
    if (!p) return fail("Vous n'êtes pas invité à cette réunion", 403, "FORBIDDEN");
  }

  const moteur = (await moteurDeLaReunion(id)) ?? "mesh";
  if (moteur === "sfu" && !appareilSaitLeSfu(req)) {
    return fail("Mettez à jour Alanya Work pour rejoindre cette réunion", 409, "APP_A_METTRE_A_JOUR");
  }
  return ok({ moteur });
});
