import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createInviteRequestSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { notifieDemandeReunion } from "@/lib/push";
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
 * GET /api/meetings/:id/invite-requests — demandes d'ajout d'une réunion.
 *
 * L'ORGANISATEUR VOIT TOUTES LES DEMANDES EN ATTENTE, chacun voit LES SIENNES.
 *
 * L'organisateur tranche, il lui faut donc la liste entière. Le proposant, lui,
 * suit sa propre demande — sans rien apprendre de celles des autres : un
 * participant n'a toujours pas à savoir qui les autres ont proposé, ni ce qui a
 * été refusé.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    select: { idOrganiser: true },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");

  /*
   * 🔴 L'ORGANISATEUR VOIT TOUT, CHACUN VOIT LES SIENNES (26/08/2026).
   *
   * Cette route rendait 403 à qui n'était pas l'organisateur. Le user veut que
   * le proposant suive sa propre demande dans la liste des membres — il faut
   * donc l'ouvrir, mais SANS ouvrir la liste entière : un participant n'a
   * toujours pas à savoir qui les autres ont proposé, ni ce qui a été refusé.
   *
   * ⚠️ LE FILTRE EST DANS LA REQUÊTE, pas après. Rendre toutes les lignes puis
   * en cacher à l'affichage laisserait les autres demandes traverser le réseau
   * — visibles de qui regarde la réponse brute.
   */
  const jeSuisOrganisateur = meeting.idOrganiser === userId;

  const demandes = await prisma.meetingInviteRequest.findMany({
    // EN ATTENTE SEULEMENT. La ligne decidee RESTE en base — c'est elle qui,
    // par la contrainte d'unicite, rend un refus definitif et empeche de
    // redemander. Mais la RENDRE ici faisait revenir la demande refusee dans le
    // bandeau de l'organisateur au rechargement suivant, soit dix secondes plus
    // tard : il la refusait, elle disparaissait, elle revenait, indefiniment.
    // L'index (idMeeting, statut) existe deja pour ce filtre.
    where: {
      idMeeting: id,
      statut: 0,
      ...(jeSuisOrganisateur ? {} : { demandeurId: userId }),
    },
    orderBy: { createdAt: "asc" },
    include: { demandeur: true, invite: true },
  });

  return ok({
    // Dit au client ce qu'il a le droit de PROPOSER comme geste : trancher, ou
    // seulement retirer. Il le déduisait de sa copie de la réunion, qui n'est
    // pas toujours chargée là où la liste s'affiche — la salle, notamment.
    jeSuisOrganisateur,
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

  // PLAFOND, AVANT TOUT AJOUT ET AVANT MEME D'ENREGISTRER LA DEMANDE.
  //
  // Deux des chemins qui suivent font ENTRER quelqu'un sans repasser par
  // l'organisateur — l'invitation automatique, et l'organisateur parti. Ce sont
  // des portes d'ajout a part entiere, faciles a oublier parce qu'elles vivent
  // dans une route qui s'appelle « demande ». Les manquer laisserait le plafond
  // se contourner par la porte la plus frequentee de toutes.
  //
  // La demande elle-meme est refusee aussi, et c'est voulu : une proposition
  // que l'organisateur ne pourrait pas accepter ne lui vaudrait qu'une
  // notification et un refus a taper, et laisserait celui qui propose attendre
  // une reponse qui ne pouvait pas etre oui. Autant le lui dire maintenant,
  // avec le chiffre.
  //
  // La position compte : ICI, avant la reouverture d'une demande refusee plus
  // bas. Refuser apres cette reouverture laisserait la ligne modifiee derriere
  // une reponse d'erreur.
  const plafond = await plafondReunion(meeting.idOrganiser, meeting.type_media);
  const occupants = occupantsContingent(
    meeting.idOrganiser,
    meeting.participants,
  );
  if (occupants.size + 1 > plafond) {
    return refusContingentPlein({
      typeMedia: meeting.type_media,
      plafond,
      actuel: occupants.size,
      demandes: 1,
    });
  }

  if (meeting.invitationAuto === 1) {
    await prisma.meetingParticipant.create({ data: { idMeeting: id, IDparticipant: invite.id, status: 0 } });
    /*
     * ⚠️ CE CHEMIN AJOUTE UN PARTICIPANT POUR DE BON, et il n'annonçait rien.
     *
     * Il est facile à manquer parce qu'il vit dans une route qui s'appelle
     * « demande » : quand l'invitation automatique est active, il n'y a pas de
     * demande du tout, quelqu'un ENTRE. Sans cette annonce, la salle et la
     * fiche de l'organisateur gardaient une liste à laquelle il manquait
     * quelqu'un — exactement le défaut signalé, par une autre porte.
     *
     * Ici l'annonce va bien À LA SALLE : la personne est entrée, tout le monde
     * la verra, il n'y a plus rien à cacher.
     */
    previensChangementParticipants({
      meetingId: id,
      motif: "PARTICIPANTS_ADDED",
      parUserId: userId,
      nombre: 1,
      personnes: [meeting.idOrganiser, invite.id],
    }).catch(() => {});
    return ok({ ajouteDirectement: true, invite: { id: invite.id } }, 201);
  }

  // Une demande existe déjà pour cette personne ? Le message dépend de son
  // sort, car les deux situations n'appellent pas la même conduite : attendre,
  // ou renoncer.
  const existante = await prisma.meetingInviteRequest.findUnique({
    where: { idMeeting_inviteId: { idMeeting: id, inviteId: invite.id } },
  });
  if (existante && existante.statut !== 2) {
    return fail(
      "Une demande concernant cette personne est déjà en attente",
      409,
      "ALREADY_PENDING",
    );
  }

  // UN REFUS N'EST PLUS DÉFINITIF : on peut redemander.
  //
  // La règle d'avant fermait la porte pour toujours, au motif qu'un participant
  // éconduit n'aurait sinon qu'à faire redemander par un collègue. C'était
  // défendable, mais ça rendait un refus irrattrapable : l'organisateur qui se
  // trompe de personne, ou qui refuse parce que la réunion n'en est pas encore
  // là, ne pouvait plus revenir dessus — et personne d'autre non plus.
  //
  // La demande repart donc à zéro : nouvel auteur, nouvelle date, décision
  // effacée. L'organisateur reçoit un nouveau message et tranche à nouveau,
  // autant de fois qu'il le faut. Le garde-fou contre l'insistance n'est plus la
  // base mais lui : il peut refuser sans fin, et chaque refus lui coûte un clic
  // quand redemander en coûte un aussi.
  //
  // La ligne est RÉUTILISÉE et non recréée : la contrainte d'unicité
  // (idMeeting, invite) l'exige, et la recréer supposerait de l'effacer d'abord,
  // donc de perdre l'historique de la première demande sans rien gagner.
  const demandeRouverte = existante
    ? await prisma.meetingInviteRequest.update({
        where: { id: existante.id },
        data: { demandeurId: userId, statut: 0, decidedAt: null, createdAt: new Date() },
        include: { demandeur: true, invite: true },
      })
    : null;

  /* 🔴 LE CONTOURNEMENT « ORGANISATEUR ABSENT » A ÉTÉ RETIRÉ LE 27/08/2026.
   *
   * Un bloc ici ajoutait la personne DIRECTEMENT, sans créer de demande, dès
   * que l'organisateur n'était pas marqué `connecte = 1`. Le user l'a constaté
   * en testant : « lorsqu'un non-admin propose un membre, cette personne entre
   * directement dans la réunion, or ce n'était pas ça ma règle de départ. »
   *
   * Vérifié dans les données avant de conclure : sur la réunion 53 (« Test
   * proposition »), AUCUNE ligne dans `meeting_invite_request`, une ligne
   * `participant` de plus, et l'organisateur à `connecte = 0`. C'est bien ce
   * chemin qui a tiré, pas l'invitation automatique — `invitation_auto` vaut 0
   * sur toutes les réunions.
   *
   * ⚠️ SA JUSTIFICATION ÉTAIT CONTREDITE PAR LE CODE. Elle disait choisir
   * `connecte` plutôt que la présence dans le salon WebSocket parce que
   * « `connecte` ne retombe que sur un départ délibéré ou la fermeture de la
   * réunion ». C'est faux : `ws-server.mjs` le remet à 0 à la FERMETURE DE LA
   * SOCKET. Une coupure réseau de l'organisateur ouvrait donc la porte, et la
   * règle d'approbation sautait sans que personne ne puisse le savoir.
   *
   * Le problème qu'il visait est réel — l'organisateur qui ne vient jamais
   * laisse les demandes sans personne pour les trancher. Mais la réponse ne
   * peut pas être de supprimer l'approbation au premier doute : elle doit se
   * fonder sur un fait durable (l'organisateur n'a JAMAIS rejoint, et la
   * réunion dure depuis un moment), pas sur l'état d'une socket. À reprendre si
   * le blocage se présente vraiment.
   *
   * NE PAS LE REMETTRE sans en reparler au user : c'est SA règle.
   */

  const demande =
    demandeRouverte ??
    (await prisma.meetingInviteRequest.create({
      data: { idMeeting: id, demandeurId: userId, inviteId: invite.id },
      include: { demandeur: true, invite: true },
    }));

  /*
   * L'ÉCRAN DÉJÀ OUVERT SE MET À JOUR (26/08/2026, demande du user).
   *
   * La notification poussée juste dessous vise des APPAREILS par leur jeton :
   * elle réveille un téléphone en veille, elle ne rafraîchit pas une fiche
   * ouverte sous les yeux de quelqu'un. L'organisateur devait tirer pour voir
   * apparaître la demande.
   *
   * ⚠️ APRÈS L'ÉCRITURE, jamais avant : l'annonce dit « votre copie est
   * périmée, relisez ». Partie trop tôt, elle enverrait relire l'ancienne
   * vérité.
   *
   * ⚠️ ELLE NE PART PAS À LA SALLE. Une demande en attente ne regarde que
   * l'organisateur et le proposant — c'est déjà la règle du GET, et la diffuser
   * à tout le monde la contredirait.
   */
  previensDemandeInvitation({
    meetingId: id,
    motif: "INVITE_REQUESTED",
    parUserId: userId,
    destinataires: [meeting.idOrganiser, userId],
  }).catch(() => {
    // `previensDemandeInvitation` ne lève pas ; ce `catch` est une ceinture.
    // La demande est écrite et valide : un pont muet ne doit rien casser.
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
