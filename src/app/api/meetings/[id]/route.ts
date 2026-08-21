import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import {
  occupantsContingent,
  plafondReunion,
} from "@/lib/plafond-reunion";
import { placesRestantes } from "@/lib/limites-reunion";

// GET /api/meetings/:id — détail d'une réunion avec tous les participants.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id);
  if (isNaN(id) || id <= 0) return fail("ID invalide", 400, "BAD_ID");

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: id },
    include: {
      organiser: true,
      participants: {
        include: { user: true },
      },
    },
  });

  if (!meeting) return fail("Réunion introuvable", 404, "NOT_FOUND");

  // Vérifier que l'utilisateur est l'organisateur ou un participant
  const isOrganiser = meeting.idOrganiser === userId;
  const isParticipant = meeting.participants.some(
    (p) => p.IDparticipant === userId,
  );
  if (!isOrganiser && !isParticipant) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }

  // LES PLACES DE CETTE REUNION.
  //
  // Trois nombres, et les trois sont necessaires : `restantes` seul ne dit pas
  // s'il s'agit d'une petite reunion presque vide ou d'une grande presque
  // pleine, et `plafond` seul ne se compare a rien tant qu'on ignore combien de
  // monde tient deja une place.
  //
  // LE COMPTAGE EST CELUI DU REFUS, PAS UN AUTRE. `occupantsContingent` est
  // exactement la fonction qu'appelle l'ajout de participants pour refuser :
  // l'organisateur compte meme sans ligne `participant`, les declines ne
  // comptent pas. Recompter ici « les participants + 1 » aurait donne un
  // chiffre proche et parfois faux — et un ecran qui annonce une place que le
  // geste suivant refuse est pire qu'un ecran sans compteur.
  //
  // POURQUOI LE CONTINGENT ET NON LA PRESENCE. Ce compteur est lu a cote du
  // bouton qui invite ; la barriere que cet ecran doit anticiper est donc celle
  // de l'ajout, qui borne le contingent. La presence, elle, borne l'entree dans
  // la salle et se lit ailleurs — `connecte`, deja envoye pour chaque
  // participant. Annoncer les places d'apres la presence ferait miroiter les
  // sieges des invites qui n'ont pas encore rejoint, et l'invitation suivante
  // serait refusee.
  //
  // LE PLAFOND SUIT L'ORGANISATEUR, pas celui qui regarde : `plafondReunion`
  // resout sur `meeting.idOrganiser`. La reunion est la sienne, et c'est ce qui
  // fait que deux personnes d'entreprises differentes ouvrant la meme reunion y
  // lisent le meme chiffre. Un plafond qui changerait selon le lecteur ne
  // serait pas un plafond, seulement un affichage.
  //
  // ⚠️ C'est une PHOTO, pas un abonnement : ces nombres valent a l'instant de
  // la lecture. Quelqu'un peut entrer entre cette reponse et l'affichage. Le
  // client relit apres chaque refus ; la barriere, elle, reste au serveur.
  const plafond = await plafondReunion(
    meeting.idOrganiser,
    meeting.type_media,
  );
  const occupants = occupantsContingent(
    meeting.idOrganiser,
    meeting.participants,
  ).size;

  return ok({
    idMeeting: meeting.idMeeting,
    objet: meeting.objet,
    type_media: meeting.type_media,
    invitationAuto: meeting.invitationAuto === 1,
    room: meeting.room,
    isEnd: meeting.isEnd,
    start_time: meeting.start_time,
    duree: meeting.duree,
    organiser: {
      id: meeting.organiser.id,
      pseudo: nomAffichage(meeting.organiser),
      publicNumber: meeting.organiser.publicNumber,
      avatarUrl: avatarPublicUrl(meeting.organiser.avatarUrl ?? null),
    },
    participants: meeting.participants.map((p) => ({
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
    isOrganiser,
    // A PLAT, et pas dans un objet `capacite` : c'est la forme que le client
    // lit deja (`capaciteBrute`), et il traite ces trois champs en TOUT OU
    // RIEN — un plafond sans occupants ne lui permettrait aucun compteur
    // honnete, il n'en afficherait alors aucun.
    plafond,
    occupants,
    restantes: placesRestantes(plafond, occupants),
  });
});
