import { prisma } from "@/lib/prisma";
import { moteurPour, type MoteurGroupes } from "@/lib/reglages-appels";

/**
 * LE MOTEUR D'UNE RÉUNION (07/11/2026), fixé à la PREMIÈRE entrée et gardé
 * jusqu'à sa fin : tous ceux qui entrent ensuite rejoignent le même.
 *
 * Le SFU n'est retenu que si la console l'a choisi et que l'organisateur et
 * tous les invités (hors refus) ont une application qui le sait
 * (`moteurPour`). `updateMany ... moteur: null` : deux premières entrées
 * simultanées ne peuvent pas fixer deux moteurs différents.
 */
export async function moteurDeLaReunion(idMeeting: number): Promise<MoteurGroupes | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting },
    select: { moteur: true, idOrganiser: true },
  });
  if (!meeting) return null;
  if (meeting.moteur) return meeting.moteur === "sfu" ? "sfu" : "mesh";

  const invites = await prisma.meetingParticipant.findMany({
    where: { idMeeting, status: { not: 2 } },
    select: { IDparticipant: true },
  });
  const choix = await moteurPour([meeting.idOrganiser, ...invites.map((p) => p.IDparticipant)]);
  await prisma.meeting.updateMany({ where: { idMeeting, moteur: null }, data: { moteur: choix } });
  const fixe = await prisma.meeting.findUnique({ where: { idMeeting }, select: { moteur: true } });
  return fixe?.moteur === "sfu" ? "sfu" : "mesh";
}
