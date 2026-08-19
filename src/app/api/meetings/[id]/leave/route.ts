import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * POST /api/meetings/:id/leave — le participant quitte la réunion.
 *
 * IDEMPOTENTE, ET C'EST LE POINT. Un départ ne peut pas échouer pour cause de
 * départ : le résultat demandé — ne plus être dans la salle — est déjà atteint
 * quand la participation est fermée, ou quand elle n'a jamais existé. Répondre
 * une erreur dans ces cas revient à annoncer une panne alors que tout va bien.
 *
 * Le chemin normal PASSE déjà deux fois ici : le client émet d'abord
 * `meeting_leave` sur la socket, et le serveur WebSocket y ferme la
 * participation ; la requête HTTP qui suit trouve donc une salle déjà quittée.
 * S'y ajoutent la fermeture d'onglet suivie d'un clic sur « Quitter », deux
 * appareils du même compte, ou un envoi `keepalive` rejoué au déchargement de
 * la page — autant de doubles départs légitimes.
 *
 * La durée n'est calculée qu'au PREMIER départ, celui qui ferme réellement la
 * participation. Les suivants renvoient celle déjà enregistrée : la recalculer
 * gonflerait le temps de présence à chaque rejeu, jusqu'à compter des heures
 * pour quelqu'un qui est parti depuis longtemps.
 */
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const participant = await prisma.meetingParticipant.findUnique({
    where: {
      idMeeting_IDparticipant: { idMeeting: id, IDparticipant: userId },
    },
  });

  // Jamais inscrit à cette réunion : il n'y est pas, ce qui est exactement ce
  // qui était demandé. Rien à fermer, rien à corriger.
  if (!participant) {
    return ok({ message: "Vous avez quitté la réunion", idMeeting: id, duree: null });
  }

  // Déjà déconnecté : on rend la durée telle qu'elle a été enregistrée à la
  // sortie qui a compté, sans réécrire la ligne.
  if (participant.connecte === 0) {
    return ok({ message: "Vous avez quitté la réunion", idMeeting: id, duree: participant.duree });
  }

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
