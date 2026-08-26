import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { addMeetingParticipantsSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { notifieInvitationReunion } from "@/lib/push";
import { previensChangementParticipants } from "@/lib/salle-temps-reel";
import {
  occupantsContingent,
  plafondReunion,
  refusContingentPlein,
} from "@/lib/plafond-reunion";

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

  // PLAFOND. Verifie sur `aAjouter` et non sur `publicNumbers` : ceux qui sont
  // deja la ont ete ecartes juste au-dessus SANS ERREUR, et les recompter ici
  // refuserait un geste qui ne fait entrer personne de plus.
  //
  // L'organisateur est dans les occupants meme s'il n'a pas encore de ligne
  // `participant` — voir `occupantsContingent`. C'est ce qui rend le compte
  // juste plutot que faux d'une unite.
  //
  // ⚠️ Deux ajouts VRAIMENT simultanes peuvent encore franchir cette porte
  // ensemble : rien ne verrouille la reunion entre le comptage et l'insertion.
  // On ne le corrige pas ici, et c'est un choix : le seul verrou honnete serait
  // une transaction serialisable posee sur chaque ajout, pour un debordement de
  // une ou deux places qui sera de toute facon arrete a l'entree de la salle,
  // ou le comptage, lui, est indivisible.
  if (aAjouter.length > 0) {
    const plafond = await plafondReunion(
      meeting.idOrganiser,
      meeting.type_media,
    );
    const occupants = occupantsContingent(
      meeting.idOrganiser,
      meeting.participants,
    );
    if (occupants.size + aAjouter.length > plafond) {
      return refusContingentPlein({
        typeMedia: meeting.type_media,
        plafond,
        actuel: occupants.size,
        demandes: aAjouter.length,
      });
    }

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

  // ET PRÉVENIR CEUX QUI SONT DÉJÀ DANS LA SALLE.
  //
  // Les notifications ci-dessus visent des APPAREILS par leur jeton : elles
  // réveillent les nouveaux ajoutés, et personne d'autre. Les participants déjà
  // en réunion ne voyaient bouger ni le compteur ni la liste, et devaient
  // sortir puis revenir. Leurs sockets vivent dans l'autre process ; le pont
  // interne est le seul chemin qui y mène depuis ici.
  //
  // APRÈS l'écriture en base, jamais avant : le message dit « relisez », et une
  // relecture partie trop tôt rapporterait l'ancienne liste.
  //
  // `previensChangementParticipants` NE LÈVE PAS. Serveur temps réel arrêté ou
  // pont non configuré, les participants sont déjà enregistrés : l'ajout reste
  // valide et la route répond son succès. On perd le rafraîchissement immédiat,
  // rien d'autre — et le journal le dit.
  //
  // Rien n'est émis quand `aAjouter` est vide : le geste a abouti, mais la
  // composition de la salle n'a pas changé, et renvoyer tout le monde relire
  // une liste identique serait du bruit.
  if (aAjouter.length > 0) {
    await previensChangementParticipants({
      meetingId: id,
      motif: "PARTICIPANTS_ADDED",
      parUserId: userId,
      nombre: aAjouter.length,
    });
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

// DELETE /api/meetings/:id/participants — exclut un participant.
//
// Body : { participantId: string }. RÉSERVÉ À L'ORGANISATEUR.
//
// Rien ne permettait de retirer quelqu'un : une personne conviée par erreur, ou
// devenue indésirable, restait dans la salle jusqu'à la fin de la réunion. La
// seule issue était de terminer la réunion pour tout le monde et d'en refaire
// une — ce qui punit l'assemblée pour la présence d'un seul.
//
// L'exclusion n'est PAS un refus d'invitation : la ligne est effacée, pas
// passée à « décliné ». Un décliné a choisi de ne pas venir et peut se raviser ;
// un exclu ne doit pas pouvoir rentrer par la porte du join, qui ne vérifie que
// l'existence de la ligne.
//
// Le départ du salon temps réel n'est toujours pas forcé ici, et l'exclu garde
// son flux jusqu'à ce qu'il quitte ou que la réunion se termine.
//
// ⚠️ CE N'EST PLUS UNE LIMITE D'ARCHITECTURE, c'est un chantier à faire. Le
// pont interne (`@/lib/salle-temps-reel`) donne désormais à cette route un
// chemin vers la salle — le POST juste au-dessus s'en sert. Il reste à décider
// ce que le serveur temps réel fait d'une exclusion : prévenir la salle ne
// suffit pas, il faut aussi fermer la place de l'exclu, ce qui touche
// `meetingRooms` et non seulement la diffusion.
export const DELETE = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const body = await req.json().catch(() => null);
  const participantId =
    body && typeof body.participantId === "string" ? body.participantId : "";
  if (!participantId) return fail("Participant manquant", 400, "BAD_REQUEST");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    select: { idMeeting: true, isEnd: true, idOrganiser: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.idOrganiser !== userId) {
    return fail("Seul l'organisateur peut exclure", 403, "FORBIDDEN");
  }
  if (meeting.isEnd === 1) {
    return fail("Cette réunion est terminée", 409, "MEETING_ENDED");
  }
  // S'exclure soi-même fermerait la réunion sans personne pour la rouvrir, et
  // laisserait les demandes d'invitation sans destinataire. Quitter est
  // l'action prévue pour cela.
  if (participantId === meeting.idOrganiser) {
    return fail(
      "L'organisateur ne peut pas s'exclure : quittez la réunion",
      400,
      "IS_ORGANISER",
    );
  }

  const participant = await prisma.meetingParticipant.findUnique({
    where: {
      idMeeting_IDparticipant: { idMeeting: id, IDparticipant: participantId },
    },
  });
  if (!participant) {
    return fail("Cette personne ne participe pas à la réunion", 404, "NOT_FOUND");
  }

  // La durée déjà passée dans la salle est arrêtée avant l'effacement : sans
  // cela, le temps de présence d'un exclu disparaîtrait des statistiques.
  const duree = participant.start_time
    ? Math.round((Date.now() - participant.start_time.getTime()) / 1000)
    : null;
  await prisma.meetingParticipant.update({
    where: { ID: participant.ID },
    data: { connecte: 0, duree },
  });
  await prisma.meetingParticipant.delete({ where: { ID: participant.ID } });

  return ok({ message: "Participant exclu", idMeeting: id, participantId });
});
