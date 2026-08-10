import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createInviteRequestSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { notifieDemandeReunion } from "@/lib/push";

/**
 * GET /api/meetings/:id/invite-requests — demandes d'ajout d'une réunion.
 *
 * Réservé à l'organisateur : c'est lui qui tranche, et lui seul a besoin de la
 * liste. Un participant n'a pas à savoir qui les autres ont proposé, ni ce qui
 * a été refusé.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    select: { idOrganiser: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.idOrganiser !== userId) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }

  const demandes = await prisma.meetingInviteRequest.findMany({
    where: { idMeeting: id },
    orderBy: { createdAt: "asc" },
    include: { demandeur: true, invite: true },
  });

  return ok({
    demandes: demandes.map((d) => ({
      id: d.id,
      statut: d.statut,
      createdAt: d.createdAt,
      decidedAt: d.decidedAt,
      demandeur: {
        id: d.demandeurId,
        pseudo: nomAffichage(d.demandeur),
        publicNumber: d.demandeur.publicNumber,
        avatarUrl: avatarPublicUrl(d.demandeur.avatarUrl ?? null),
      },
      invite: {
        id: d.inviteId,
        pseudo: nomAffichage(d.invite),
        publicNumber: d.invite.publicNumber,
        avatarUrl: avatarPublicUrl(d.invite.avatarUrl ?? null),
      },
    })),
  });
});

/**
 * POST /api/meetings/:id/invite-requests — proposer quelqu'un à l'organisateur.
 *
 * ⚠️ LA PERSONNE PROPOSÉE N'EST PRÉVENUE DE RIEN À CE STADE, et ne le sera que
 * si la demande est acceptée. Tant que l'organisateur n'a pas tranché, elle
 * n'existe pas pour cette réunion : aucune ligne dans `participant`, aucune
 * notification. Un refus doit rester invisible pour elle.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const { publicNumber } = createInviteRequestSchema.parse(await req.json());

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: { organiser: true, participants: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.isEnd === 1) {
    return fail("Cette réunion est terminée", 409, "MEETING_ENDED");
  }

  // L'organisateur n'a rien à demander : il ajoute directement (voir
  // `POST .../participants`). Le lui refuser explicitement vaut mieux que de
  // créer une demande qu'il s'adresserait à lui-même.
  if (meeting.idOrganiser === userId) {
    return fail(
      "Vous organisez cette réunion : ajoutez directement le participant",
      400,
      "IS_ORGANISER",
    );
  }
  const estParticipant = meeting.participants.some(
    (p) => p.IDparticipant === userId,
  );
  if (!estParticipant) {
    return fail("Vous ne participez pas à cette réunion", 403, "FORBIDDEN");
  }

  const invite = await prisma.user.findUnique({
    where: { publicNumber },
    select: { id: true },
  });
  if (!invite) return fail("Numéro introuvable", 404, "NOT_FOUND");

  if (
    invite.id === meeting.idOrganiser ||
    meeting.participants.some((p) => p.IDparticipant === invite.id)
  ) {
    return fail(
      "Cette personne fait déjà partie de la réunion",
      409,
      "ALREADY_IN",
    );
  }

  // Une demande existe déjà pour cette personne ? Le message dépend de son
  // sort, car les deux situations n'appellent pas la même conduite : attendre,
  // ou renoncer.
  const existante = await prisma.meetingInviteRequest.findUnique({
    where: { idMeeting_inviteId: { idMeeting: id, inviteId: invite.id } },
  });
  if (existante) {
    if (existante.statut === 2) {
      // Refus DÉFINITIF, et il l'est pour tout le monde : sans cela, un
      // participant éconduit n'aurait qu'à faire redemander par un collègue.
      return fail(
        "L'organisateur a déjà refusé d'ajouter cette personne",
        409,
        "ALREADY_REFUSED",
      );
    }
    return fail(
      "Une demande concernant cette personne est déjà en attente",
      409,
      "ALREADY_PENDING",
    );
  }

  // ORGANISATEUR ABSENT : le participant ajoute directement.
  //
  // Une demande n'a de sens que si quelqu'un peut la trancher. L'organisateur
  // parti, elles s'empilaient sans destinataire et plus personne n'entrait
  // dans une réunion pourtant en cours — un blocage d'autant plus penible que
  // rien à l'écran n'en donnait la raison.
  //
  // « Absent » se lit sur `connecte`, pas sur la présence dans le salon
  // WebSocket : la seconde bascule à chaque coupure réseau, et la règle
  // changerait sous les pieds des participants au gré de la connexion de
  // l'organisateur. `connecte` ne retombe que sur un départ délibéré ou la
  // fermeture de la réunion.
  //
  // L'organisateur n'a pas forcément de ligne `participant` — il peut avoir
  // convoqué sans jamais entrer. Dans ce cas il n'est pas dans la salle non
  // plus, et la même règle s'applique.
  const ligneOrganisateur = meeting.participants.find(
    (p) => p.IDparticipant === meeting.idOrganiser,
  );
  const organisateurAbsent = !ligneOrganisateur || ligneOrganisateur.connecte !== 1;

  if (organisateurAbsent) {
    await prisma.meetingParticipant.create({
      data: { idMeeting: id, IDparticipant: invite.id, status: 0 },
    });
    return ok(
      {
        ajouteDirectement: true,
        invite: { id: invite.id },
      },
      201,
    );
  }

  const demande = await prisma.meetingInviteRequest.create({
    data: { idMeeting: id, demandeurId: userId, inviteId: invite.id },
    include: { demandeur: true, invite: true },
  });

  // Seul l'organisateur est prévenu.
  notifieDemandeReunion({
    recipientId: meeting.idOrganiser,
    meetingId: id,
    objet: meeting.objet,
    demandeurName: nomAffichage(demande.demandeur) ?? "Un participant",
    inviteName: nomAffichage(demande.invite) ?? "un contact",
  }).catch((e) =>
    console.error("[meetings] notification de demande:", e?.message ?? e),
  );

  return ok(
    {
      id: demande.id,
      statut: demande.statut,
      invite: {
        id: demande.inviteId,
        pseudo: nomAffichage(demande.invite),
        publicNumber: demande.invite.publicNumber,
      },
    },
    201,
  );
});
