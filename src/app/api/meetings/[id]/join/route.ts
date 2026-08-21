import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  plafondReunion,
  presentsEnBase,
  refusSallePleine,
} from "@/lib/plafond-reunion";

// POST /api/meetings/:id/join — accepte l'invitation et marque le participant comme connecté.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
  });
  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");
  if (meeting.isEnd === 1) return fail("Cette réunion est terminée", 400, "ENDED");

  // TOUTES les lignes, et non la seule de l'appelant : la meme lecture sert a
  // savoir s'il est invite et a compter qui est deja dans la salle. Deux
  // requetes pour la meme table sur le chemin d'une entree seraient du gaspi.
  const participants = await prisma.meetingParticipant.findMany({
    where: { idMeeting: id },
  });
  const participant =
    participants.find((p) => p.IDparticipant === userId) ?? null;

  // L'AUTORISATION D'ABORD, LE PLAFOND ENSUITE. Repondre « c'est plein » a
  // quelqu'un qui n'est pas invite lui apprendrait combien de monde se trouve
  // dans une reunion dont il n'a pas a connaitre l'existence.
  if (!participant && meeting.idOrganiser !== userId) {
    return fail("Vous n'êtes pas invité à cette réunion", 403, "FORBIDDEN");
  }

  // PLAFOND A L'ENTREE — la PRESENCE, pas le contingent.
  //
  // Compter les invites ici serait une faute : une reunion peut en compter
  // trente — creee avant ce garde-fou, ou passee de l'audio a la video apres
  // coup — et l'on refuserait alors l'entree au PREMIER arrivant, dans une
  // salle vide. Ce qui charge les machines, ce sont ceux qui sont la
  // maintenant.
  //
  // L'ORGANISATEUR N'EST PAS AU-DESSUS : il passe par cette porte comme les
  // autres, et il compte dans le total comme les autres.
  //
  // Sa propre place est deduite du compte — on compte les AUTRES, puis on
  // ajoute un. Sans ce retrait, celui qui revient apres une coupure, sa ligne
  // encore marquee `connecte`, se refuserait lui-meme une salle qu'il n'a
  // jamais quittee.
  const presents = presentsEnBase(participants);
  presents.delete(userId);
  const plafond = await plafondReunion(meeting.idOrganiser, meeting.type_media);
  if (presents.size + 1 > plafond) {
    return refusSallePleine({
      typeMedia: meeting.type_media,
      plafond,
      actuel: presents.size,
    });
  }

  // Si l'utilisateur n'est pas encore dans la liste, l'ajouter (l'organisateur peut rejoindre directement)
  if (!participant) {
    // L'organisateur rejoint : créer son entrée participant.
    //
    // Cette creation ne fait PAS grossir le contingent : l'organisateur y
    // comptait deja sans ligne, c'est la regle de `occupantsContingent`. Elle
    // ne fait qu'ecrire ce qui etait vrai.
    await prisma.meetingParticipant.create({
      data: {
        idMeeting: id,
        IDparticipant: userId,
        status: 1,
        connecte: 1,
        start_time: new Date(),
      },
    });
  } else {
    await prisma.meetingParticipant.update({
      where: { ID: participant.ID },
      data: {
        status: 1, // accepté
        connecte: 1,
        start_time: new Date(),
      },
    });
  }

  return ok({ message: "Connecté à la réunion", idMeeting: id });
});
