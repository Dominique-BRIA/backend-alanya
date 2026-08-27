import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { decideInviteRequestSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import {
  notifieInvitationReunion,
  notifieDecisionDemandeReunion,
} from "@/lib/push";
import {
  previensChangementParticipants,
  previensDemandeInvitation,
} from "@/lib/salle-temps-reel";
import {
  occupantsContingent,
  plafondReunion,
  refusContingentPlein,
} from "@/lib/plafond-reunion";

/**
 * PATCH /api/meetings/:id/invite-requests/:reqId — l'organisateur tranche.
 *
 * Qui apprend quoi, et c'est le cœur de ce lot :
 *
 *   accepté  → le DEMANDEUR est prévenu que c'est passé ;
 *              la PERSONNE PROPOSÉE reçoit une invitation ordinaire ;
 *   refusé   → le DEMANDEUR est prévenu ;
 *              la PERSONNE PROPOSÉE n'apprend RIEN, jamais.
 *
 * ⚠️ L'invitation envoyée en cas d'acceptation est celle qu'envoie
 * l'organisateur quand il ajoute quelqu'un lui-même — volontairement
 * indiscernable. Rien ne doit indiquer à l'intéressé qu'un tiers l'a proposé,
 * ni qu'il aurait pu être refusé.
 */
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const params = await ctx.params;
  const id = Number(params.id);
  const reqId = Number(params.reqId);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");
  if (isNaN(reqId) || reqId <= 0) {
    return fail("Demande invalide", 400, "BAD_REQUEST_ID");
  }

  const { accepter } = decideInviteRequestSchema.parse(await req.json());

  const demande = await prisma.meetingInviteRequest.findUnique({
    where: { id: reqId },
    // Les participants de la reunion viennent avec : c'est sur eux que se
    // compte le plafond, et les charger ici evite une seconde lecture.
    include: {
      meeting: { include: { participants: true } },
      demandeur: true,
      invite: true,
    },
  });
  if (!demande || demande.idMeeting !== id) {
    return fail("Demande introuvable", 404, "NOT_FOUND");
  }
  if (demande.meeting.idOrganiser !== userId) {
    return fail("Seul l'organisateur peut trancher", 403, "FORBIDDEN");
  }
  // Déjà tranchée : ne pas rejouer les notifications. Un double clic, ou deux
  // appareils de l'organisateur, en enverraient sinon un second jeu.
  if (demande.statut !== 0) {
    return fail("Cette demande a déjà été tranchée", 409, "ALREADY_DECIDED");
  }

  const inviteName = nomAffichage(demande.invite) ?? "un contact";
  const objet = demande.meeting.objet;

  if (accepter) {
    // PLAFOND. Le contingent a pu se remplir entre la demande et la decision —
    // l'organisateur a ajoute du monde entre-temps, ou une autre demande est
    // passee avant celle-ci. C'est le dernier moment ou l'on peut encore
    // l'arreter avant qu'elle ne devienne une invitation.
    //
    // LA DEMANDE RESTE EN ATTENTE. Ne pas la marquer tranchee est delibere :
    // l'organisateur peut exclure quelqu'un, puis revenir l'accepter. La
    // classer ici l'obligerait a la faire reformuler par son auteur, pour un
    // refus qui n'est pas le sien.
    //
    // La personne deja occupante ne peut pas remplir la salle une seconde fois
    // — la ligne `participant` a pu naitre par un autre chemin depuis. Dans ce
    // cas l'acceptation ne fait entrer personne et ne doit rien refuser.
    const occupants = occupantsContingent(
      demande.meeting.idOrganiser,
      demande.meeting.participants,
    );
    if (!occupants.has(demande.inviteId)) {
      const plafond = await plafondReunion(
        demande.meeting.idOrganiser,
        demande.meeting.type_media,
      );
      if (occupants.size + 1 > plafond) {
        return refusContingentPlein({
          typeMedia: demande.meeting.type_media,
          plafond,
          actuel: occupants.size,
          demandes: 1,
        });
      }
    }

    // L'ajout et la décision dans la MÊME transaction : une demande marquée
    // acceptée alors que la ligne `participant` manquerait laisserait la
    // personne hors de la réunion sans que rien ne le signale, et la contrainte
    // d'unicité interdirait de recommencer.
    await prisma.$transaction([
      prisma.meetingParticipant.createMany({
        data: [{ idMeeting: id, IDparticipant: demande.inviteId, status: 0 }],
        skipDuplicates: true,
      }),
      prisma.meetingInviteRequest.update({
        where: { id: reqId },
        data: { statut: 1, decidedAt: new Date() },
      }),
    ]);

    const organiserName =
      nomAffichage(
        await prisma.user.findUniqueOrThrow({
          where: { id: demande.meeting.idOrganiser },
        }),
      ) ?? "Un contact";
    notifieInvitationReunion({
      recipientId: demande.inviteId,
      meetingId: id,
      objet,
      organiserName,
      enCours: demande.meeting.start_time.getTime() <= Date.now(),
    }).catch((e) =>
      console.error("[meetings] invitation après acceptation:", e?.message ?? e),
    );
  } else {
    await prisma.meetingInviteRequest.update({
      where: { id: reqId },
      data: { statut: 2, decidedAt: new Date() },
    });
    // La ligne refusée RESTE en base : c'est elle qui, par la contrainte
    // d'unicité (idMeeting, invite), rend le refus définitif et empêche un
    // autre participant de redemander la même personne.
  }

  /*
   * LES ÉCRANS DÉJÀ OUVERTS SE METTENT À JOUR (26/08/2026).
   *
   * Deux annonces, et pas une seule, parce que les deux nouvelles n'ont pas le
   * même public :
   *
   *  - LA DEMANDE A DISPARU de la liste des demandes en attente. Cela ne
   *    regarde que l'organisateur et le proposant — refusée, elle doit rester
   *    invisible pour tous les autres, la personne proposée en tête ;
   *  - EN CAS D'ACCEPTATION, un participant est entré. Là, toute la salle est
   *    concernée : la liste des membres a changé pour tout le monde.
   *
   * ⚠️ APRÈS L'ÉCRITURE, jamais avant : l'annonce dit « relisez ». Partie trop
   * tôt, elle ferait relire l'ancienne vérité.
   */
  previensDemandeInvitation({
    meetingId: id,
    motif: "INVITE_DECIDED",
    parUserId: userId,
    destinataires: [demande.meeting.idOrganiser, demande.demandeurId],
  }).catch(() => {});

  if (accepter) {
    previensChangementParticipants({
      meetingId: id,
      motif: "PARTICIPANTS_ADDED",
      parUserId: userId,
      nombre: 1,
      // La personne acceptée est prévenue elle aussi : sa propre liste de
      // réunions vient de gagner une ligne.
      personnes: [demande.inviteId],
    }).catch(() => {});
  }

  // Le demandeur est prévenu dans les DEUX cas — c'est lui qui attend une
  // réponse. La personne proposée, elle, n'est prévenue que si c'est accepté,
  // et par l'invitation ci-dessus.
  notifieDecisionDemandeReunion({
    recipientId: demande.demandeurId,
    meetingId: id,
    objet,
    inviteName,
    accepte: accepter,
  }).catch((e) =>
    console.error("[meetings] notification de décision:", e?.message ?? e),
  );

  return ok({ id: reqId, statut: accepter ? 1 : 2 });
});

/**
 * DELETE /api/meetings/:id/invite-requests/:reqId — le proposant retire sa demande.
 *
 * 🔴 SEUL LE PROPOSANT PEUT RETIRER, et seulement TANT QUE L'ORGANISATEUR N'A
 * PAS TRANCHÉ. Demandé par le user le 26/08/2026 : la demande en attente
 * s'affiche désormais dans la liste des membres, et celui qui l'a faite doit
 * pouvoir la reprendre.
 *
 * ⚠️ LA COURSE EST TRANCHÉE EN FAVEUR DE L'ORGANISATEUR, et c'est le point qui
 * compte ici. Il peut accepter à l'instant où l'autre retire. Le contrôle porte
 * donc sur le STATUT EN BASE, dans le `where` de l'écriture : si la ligne n'est
 * plus en attente, aucune ligne n'est touchée et on répond 409. Lire puis
 * écrire en deux temps laisserait passer les deux gestes, et une demande
 * acceptée — avec son participant déjà créé — serait effacée derrière.
 *
 * ⚠️ LA LIGNE EST SUPPRIMÉE, PAS MARQUÉE. Un statut « retirée » aurait bloqué
 * pour toujours, par la contrainte d'unicité `(idMeeting, invite)`, toute
 * nouvelle proposition de la même personne — alors que retirer n'est pas
 * refuser. Le refus, lui, garde sa ligne : c'est ce qui le rend définitif.
 */
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const params = await ctx.params;
  const id = Number(params.id);
  const reqId = Number(params.reqId);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");
  if (isNaN(reqId) || reqId <= 0) {
    return fail("Demande invalide", 400, "BAD_REQUEST_ID");
  }

  const demande = await prisma.meetingInviteRequest.findUnique({
    where: { id: reqId },
    select: {
      idMeeting: true,
      demandeurId: true,
      statut: true,
      meeting: { select: { idOrganiser: true } },
    },
  });
  if (!demande || demande.idMeeting !== id) {
    return fail("Demande introuvable", 404, "NOT_FOUND");
  }
  if (demande.demandeurId !== userId) {
    return fail(
      "Seule la personne qui a proposé peut retirer sa demande",
      403,
      "FORBIDDEN",
    );
  }

  // Le `statut: 0` du `where` est le contrôle qui compte : c'est la base qui
  // arbitre, pas la lecture faite deux lignes plus haut.
  const { count } = await prisma.meetingInviteRequest.deleteMany({
    where: { id: reqId, demandeurId: userId, statut: 0 },
  });
  if (count === 0) {
    return fail(
      "L'organisateur a déjà tranché cette demande",
      409,
      "ALREADY_DECIDED",
    );
  }

  previensDemandeInvitation({
    meetingId: id,
    motif: "INVITE_CANCELLED",
    parUserId: userId,
    destinataires: [demande.meeting.idOrganiser, userId],
  }).catch(() => {});

  return ok({ id: reqId, retiree: true });
});
