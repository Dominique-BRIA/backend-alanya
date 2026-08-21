import { NextResponse } from "next/server";
import {
  CODE_SALLE_PLEINE,
  limitePourTypeMedia,
  limitesPour,
  messageCreationTropGrande,
  messageSallePleine,
  placesRestantes,
} from "./limites-reunion";

/**
 * APPLICATION du plafond de participants a une reunion.
 *
 * Ce module ne DECIDE de rien : `limites-reunion` est la source unique du
 * chiffre, et il tranche seul la precedence entreprise / global / defaut. Ici
 * on repond a l'autre question, celle qui decide si le plafond mord ou reste
 * decoratif : QUI COMPTE, et a quel moment on regarde.
 *
 * DEUX GRANDEURS SONT BORNEES, ET C'EST DELIBERE.
 *
 *   Le CONTINGENT — combien de personnes tiennent une place dans la reunion,
 *   entrees ou non. Borne a la creation, a l'ajout, a la demande d'invitation
 *   et a son acceptation. Il ne protege aucune machine : il PREVIENT TOT. Sans
 *   lui, on peut convier trente personnes et les laisser decouvrir a la porte,
 *   une par une, qu'elles ne rentreront pas — un refus juste, mais brutal, et
 *   repete trente fois.
 *
 *   La PRESENCE — combien de personnes sont dans la salle a cet instant. C'est
 *   la seule barriere qui protege reellement, et la seule qui reste vraie quand
 *   le contingent ne l'est plus : reunion creee avant l'existence de ce
 *   garde-fou, plafond baisse par le superuser apres coup, reunion passee de
 *   l'audio a la video.
 *
 * Le contingent seul serait decoratif. La presence seule serait brutale. Les
 * deux, et le refus arrive tot sans jamais pouvoir etre contourne.
 *
 * ⚠️ LA BARRIERE QUI COMPTE VRAIMENT N'EST PAS ICI mais dans ws-server.mjs :
 * c'est lui qui tient les sockets de la salle, donc lui seul qui sait qui est
 * la a la milliseconde pres. Les routes de ce module comptent `connecte` en
 * base, qui ne retombe que sur un depart delibere — une machine qui meurt sans
 * prevenir y laisse sa place occupee.
 */

/// Les colonnes de `participant` dont le comptage a besoin, et rien de plus :
/// tout appelant qui a charge les lignes completes satisfait ce type.
export type LigneParticipant = {
  IDparticipant: string;
  status: number;
  connecte: number;
};

/**
 * Le plafond applicable a UNE reunion precise.
 *
 * Deux choix s'y jouent, et aucun n'est evident.
 *
 * LE TYPE EST RELU A CHAQUE FOIS, jamais retenu d'un appel sur l'autre. Une
 * reunion qui passerait de l'audio a la video verrait son plafond se resserrer
 * sans qu'on ait a y penser : le prochain arrivant se heurte au bon chiffre,
 * meme si les invitations ont ete lancees sous l'ancien.
 *
 * LES LIMITES SUIVENT L'ORGANISATEUR, jamais l'auteur de la requete. La reunion
 * est la sienne. Si le plafond suivait l'appelant, la meme salle accepterait un
 * septieme participant parce qu'un invite d'une entreprise genereuse pousse la
 * porte, et le refuserait a son voisin une seconde plus tard. Un plafond qui
 * change selon qui frappe n'est pas un plafond.
 */
export async function plafondReunion(
  idOrganiser: string,
  typeMedia: number,
): Promise<number> {
  return limitePourTypeMedia(await limitesPour(idOrganiser), typeMedia);
}

/**
 * Qui tient une place dans la reunion, entre ou non.
 *
 * L'ORGANISATEUR EN FAIT PARTIE, toujours, meme sans ligne dans `participant` —
 * il peut avoir convoque sans jamais entrer, sa ligne n'etant creee qu'a sa
 * premiere entree. L'oublier rendrait le plafond faux d'une unite : six invites
 * plus lui font sept flux a encoder par machine, pas six. C'est aussi ce que
 * dit la convention de `limites-reunion` : ces nombres comptent les personnes
 * dans la salle, organisateur compris.
 *
 * LE DECLINE N'EN FAIT PAS PARTIE. Il a dit non ; lui garder une place la
 * gaspillerait pour quelqu'un qui ne viendra pas. S'il se ravise, il repasse
 * par l'entree, ou sa place est recomptee — et peut lui etre refusee.
 *
 * Un ENSEMBLE et non un compte : l'organisateur peut avoir sa propre ligne dans
 * `participant`, et le compter deux fois retirerait une place a tout le monde.
 */
export function occupantsContingent(
  idOrganiser: string,
  participants: LigneParticipant[],
): Set<string> {
  const occupants = new Set<string>([idOrganiser]);
  for (const p of participants) {
    if (p.status === 2) continue;
    occupants.add(p.IDparticipant);
  }
  return occupants;
}

/**
 * Qui est dans la salle, vu depuis la base.
 *
 * `connecte` est le seul signal de presence qu'une route HTTP puisse lire : la
 * salle temps reel vit dans le process WebSocket, qui ne parle pas a celui-ci.
 * Le drapeau ne retombe que sur un depart delibere, un refus d'invitation ou la
 * fin de la reunion.
 *
 * ⚠️ Il SURESTIME donc la presence : une machine qui meurt sans prevenir laisse
 * sa place occupee jusqu'a la fin de la reunion. C'est assume — le client web
 * previent au dechargement de la page (`pagehide` + `keepalive`), le cas est
 * rare, et le prix d'une place gardee de trop est plus faible que celui d'une
 * place de trop accordee : la vraie barriere, elle, compte des sockets.
 */
export function presentsEnBase(participants: LigneParticipant[]): Set<string> {
  const presents = new Set<string>();
  for (const p of participants) {
    if (p.connecte === 1) presents.add(p.IDparticipant);
  }
  return presents;
}

/**
 * Le corps commun a tous les refus de plafond.
 *
 * LES CHIFFRES SONT DANS LE CORPS, pas seulement dans la phrase. Le texte du
 * serveur n'est JAMAIS traduit et cette application parle neuf langues : le
 * client refait sa propre phrase a partir de `plafond`, `actuel` et `demandes`.
 * Le message francais reste la pour les journaux et pour un client qui ne
 * connaitrait pas encore le code.
 *
 * UN SEUL CODE, `MEETING_FULL`, pour tous les refus de plafond — creation,
 * ajout, demande, entree. Le client n'a qu'une chose a savoir : c'est plein.
 * Ce dont il a besoin pour nuancer sa phrase, ce ne sont pas trois codes mais
 * les nombres, qui sont la.
 */
function refusPlafond(args: {
  message: string;
  plafond: number;
  actuel: number;
  demandes: number;
  typeMedia: number;
}) {
  const { message, plafond, actuel, demandes, typeMedia } = args;
  return NextResponse.json(
    {
      error: {
        message,
        code: CODE_SALLE_PLEINE,
        plafond,
        actuel,
        demandes,
        restantes: placesRestantes(plafond, actuel),
        typeMedia,
      },
    },
    // 409 et non 403 : rien n'est interdit a cette personne, c'est l'etat de la
    // reunion a cet instant qui s'y oppose. Le meme geste reussira quand
    // quelqu'un sera parti.
    { status: 409 },
  );
}

/// Refus a la CREATION : la reunion demandee naitrait deja trop grande.
/// `demandes` compte l'organisateur, puisque le plafond le compte.
export function refusCreationTropGrande(args: {
  typeMedia: number;
  plafond: number;
  demandes: number;
}) {
  const { typeMedia, plafond, demandes } = args;
  return refusPlafond({
    message: messageCreationTropGrande(typeMedia, plafond, demandes),
    plafond,
    // Rien n'existe encore : la seule personne deja acquise est l'organisateur.
    actuel: 1,
    demandes,
    typeMedia,
  });
}

/// Refus d'AJOUTER, de PROPOSER ou d'ACCEPTER : le contingent deborderait.
export function refusContingentPlein(args: {
  typeMedia: number;
  plafond: number;
  actuel: number;
  demandes: number;
}) {
  const { typeMedia, plafond, actuel, demandes } = args;
  return refusPlafond({
    message: messageSallePleine(typeMedia, plafond),
    plafond,
    actuel,
    demandes,
    typeMedia,
  });
}

/// Refus d'ENTRER : la salle est pleine a cet instant.
export function refusSallePleine(args: {
  typeMedia: number;
  plafond: number;
  actuel: number;
}) {
  const { typeMedia, plafond, actuel } = args;
  return refusPlafond({
    message: messageSallePleine(typeMedia, plafond),
    plafond,
    actuel,
    demandes: 1,
    typeMedia,
  });
}
