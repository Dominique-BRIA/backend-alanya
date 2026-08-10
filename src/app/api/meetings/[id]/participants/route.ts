import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { addMeetingParticipantsSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { notifieInvitationReunion } from "@/lib/push";

// POST /api/meetings/:id/participants — ajoute des participants à une réunion.
//
// Rien ne permettait d'agrandir une réunion : la liste était figée à la
// création. Il fallait en créer une seconde pour une personne oubliée, ce qui
// scindait la conversation en deux salles.
//
// Marche AVANT comme PENDANT la réunion. La seule différence est le texte de la
// notification, qui précise qu'elle a déjà commencé — l'ajouté a besoin de le
// savoir pour décider de rejoindre tout de suite.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const { publicNumbers } = addMeetingParticipantsSchema.parse(await req.json());

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: { organiser: true, participants: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");

  // ORGANISATEUR SEUL. C'est lui qui a convoqué la réunion ; laisser n'importe
  // quel participant y faire entrer qui il veut reviendrait à lui retirer la
  // maîtrise de sa propre salle. Un participant qui souhaite faire venir
  // quelqu'un passe par une DEMANDE, qu'il valide (lot suivant).
  if (meeting.idOrganiser !== userId) {
    return fail(
      "Seul l'organisateur peut ajouter des participants",
      403,
      "FORBIDDEN",
    );
  }
  if (meeting.isEnd === 1) {
    return fail("Cette réunion est terminée", 409, "MEETING_ENDED");
  }

  const users = await prisma.user.findMany({
    where: { publicNumber: { in: publicNumbers } },
    select: { id: true, publicNumber: true },
  });
  const trouves = new Set(users.map((u) => u.publicNumber));
  const manquants = publicNumbers.filter((n) => !trouves.has(n));
  if (manquants.length > 0) {
    return fail(
      `Numéro(s) introuvable(s) : ${manquants.join(", ")}`,
      404,
      "NOT_FOUND",
    );
  }

  // L'organisateur et les membres déjà présents sont écartés SANS ERREUR : le
  // geste « ajouter ces personnes » doit aboutir même si l'une d'elles était
  // déjà là, sinon l'utilisateur doit deviner laquelle retirer de sa sélection.
  const dejaLa = new Set(meeting.participants.map((p) => p.IDparticipant));
  const aAjouter = users
    .map((u) => u.id)
    .filter((uid) => uid !== meeting.idOrganiser && !dejaLa.has(uid));

  if (aAjouter.length > 0) {
    await prisma.meetingParticipant.createMany({
      data: aAjouter.map((uid) => ({
        idMeeting: id,
        IDparticipant: uid,
        status: 0, // invité
      })),
      // Filet contre le double clic : deux requêtes parallèles verraient le
      // même `dejaLa` et tenteraient la même insertion, que la contrainte
      // d'unicité (idMeeting, IDparticipant) refuserait.
      skipDuplicates: true,
    });
  }

  // Notifier les NOUVEAUX seulement. Renotifier ceux qui étaient déjà là, à
  // chaque ajout, transformerait la réunion en source de bruit.
  const organiserName = nomAffichage(meeting.organiser) ?? "Un contact";
  const enCours = meeting.start_time.getTime() <= Date.now();
  for (const uid of aAjouter) {
    notifieInvitationReunion({
      recipientId: uid,
      meetingId: id,
      objet: meeting.objet,
      organiserName,
      enCours,
    }).catch((e) =>
      console.error("[meetings] notification d'ajout:", e?.message ?? e),
    );
  }

  // La liste complète à jour, pour que le client n'ait pas à recharger.
  const participants = await prisma.meetingParticipant.findMany({
    where: { idMeeting: id },
    include: { user: true },
  });

  return ok({
    idMeeting: id,
    ajoutes: aAjouter.length,
    participants: participants.map((p) => ({
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
  });
});
