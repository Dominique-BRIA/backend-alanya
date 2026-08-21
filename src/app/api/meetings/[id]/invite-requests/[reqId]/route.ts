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
