// Libellés d'appel — implémentation UNIQUE, partagée par les deux processus.
//
// Pourquoi du JavaScript et non du TypeScript : `ws-server.mjs` est un process
// Node séparé, lancé directement par PM2 sans passer par la compilation de
// Next.js. Il ne peut donc pas importer `src/lib/calls.ts`. Écrire ces règles
// ici, en JS pur, permet aux DEUX de s'en servir — `calls.ts` les réexporte
// avec leurs types, `ws-server.mjs` les importe telles quelles.
//
// L'alternative aurait été de dupliquer la logique dans le serveur WebSocket.
// C'est exactement ce qu'il faut éviter : le formalisme finirait par diverger
// entre l'historique (HTTP) et le temps réel (WS), et le même appel changerait
// de libellé selon le chemin par lequel il arrive.

import { nomAffichage } from "./display-name.mjs";

/// Délai au bout duquel un appel qui sonne est considéré sans réponse.
///
/// 90 s et non 2 min : c'est la valeur du minuteur Telecom côté Android. Quand
/// les deux divergent, l'appel disparaît de l'écran du téléphone avant que le
/// serveur ne le clôture, et l'utilisateur voit une sonnerie fantôme.
export const DELAI_SANS_REPONSE_MS = 90 * 1000;

/**
 * Formule un statut d'appel DU POINT DE VUE d'un destinataire donné.
 *
 * C'est le seul endroit où la nuance appelant/appelé est décidée. Le client se
 * contente d'afficher : il n'a plus à déduire quoi que ce soit de `durationSec`
 * ou du statut brut, ce qui produisait « Rejeté » des deux côtés d'un même
 * appel.
 *
 * La règle : B ne décroche pas → « sans réponse » chez A, « manqué » chez B.
 * B refuse → « refusé » chez A, « rejeté » chez B.
 *
 * `preciseStatus` est le libellé complet des listes (« Appel manqué ») ;
 * `detail` est sa forme courte pour la bulle du fil, où le type d'appel est
 * déjà écrit au-dessus (« Appel vocal entrant » / « Manqué »).
 */
export function libelleAppel(status, isOutgoing, durationSec) {
  const echec = (preciseStatus, detail) => ({
    preciseStatus,
    detail,
    isFailed: true,
    colorHint: "danger",
  });

  switch (status) {
    case "REJECTED":
      return isOutgoing
        ? echec("Appel refusé", "Refusé")
        : echec("Appel rejeté", "Rejeté");

    // MISSED est l'ancienne écriture de NO_ANSWER : même fait, même rendu.
    case "NO_ANSWER":
    case "MISSED":
      return isOutgoing
        ? echec("Appel sans réponse", "Sans réponse")
        : echec("Appel manqué", "Manqué");

    case "BUSY":
      // Côté appelé, l'appel n'a jamais sonné : il était en ligne. Le présenter
      // comme « manqué » est ce qui décrit le mieux ce qu'il a vécu.
      return isOutgoing
        ? echec("Occupé", "Occupé")
        : echec("Appel manqué", "Manqué");

    case "RINGING":
      return { preciseStatus: "Sonnerie", detail: "En cours", isFailed: false, colorHint: "neutral" };

    case "ONGOING":
      return { preciseStatus: "En cours", detail: "En cours", isFailed: false, colorHint: "neutral" };

    case "ENDED":
      // Un ENDED sans durée est un appel que personne n'a décroché : c'est
      // l'ancien comportement de `end/route.ts`, encore présent dans les
      // données. Le nouveau code écrit NO_ANSWER dans ce cas.
      if (durationSec === null || durationSec === undefined || durationSec <= 0) {
        return isOutgoing
          ? echec("Appel sans réponse", "Sans réponse")
          : echec("Appel manqué", "Manqué");
      }
      return {
        preciseStatus: isOutgoing ? "Appel sortant" : "Appel entrant",
        detail: "Répondu",
        isFailed: false,
        colorHint: isOutgoing ? "positive" : "info",
      };

    default:
      return { preciseStatus: status, detail: null, isFailed: false, colorHint: "neutral" };
  }
}

/**
 * Statut d'un appel DU POINT DE VUE d'un participant, quand celui-ci en est
 * sorti alors qu'il continuait sans lui.
 *
 * C'est le cas du TRANSFERT : A est en communication avec B, B transfère à C.
 * `POST /api/calls/:id/leave` pose `leftAt` sur la ligne de B — ce qui le rend
 * de nouveau joignable, `estOccupe` le regarde — mais `Call.status` reste
 * `ONGOING`, et c'est correct : A et C sont toujours en ligne. Marquer l'appel
 * `ENDED` raccrocherait A et C, donc casserait le transfert.
 *
 * Le statut global n'est donc PAS le statut de B. Sans cette fonction, B voyait
 * « en cours » indéfiniment dans sa liste d'appels et dans son fil avec A, pour
 * un appel qu'il avait quitté.
 *
 * La durée suit la même logique : c'est celle de la PARTICIPATION de B, pas
 * celle de l'appel, qui court encore. Le début retenu est le plus tardif entre
 * son `joinedAt` et le `answeredAt` de l'appel : chez l'appelant, `joinedAt` est
 * posé à la création, alors que l'appel sonne encore, et compter la sonnerie
 * dans la durée de conversation serait faux.
 *
 * @returns {{status: string, endedAt: Date|string|null, durationSec: number|null,
 *            hasLeft: boolean, leftAt: Date|string|null}}
 */
export function vueDuParticipant(call, pourUserId) {
  const moi = (call.participants ?? []).find((p) => p.userId === pourUserId);
  const leftAt = moi?.leftAt ?? null;
  const finGlobale = call.endedAt ?? null;

  const dureeEntre = (debut, fin) =>
    debut && fin
      ? Math.round((new Date(fin).getTime() - new Date(debut).getTime()) / 1000)
      : null;

  const vueGlobale = {
    status: call.status,
    endedAt: finGlobale,
    durationSec: call.answeredAt && finGlobale ? dureeEntre(call.answeredAt, finGlobale) : null,
    hasLeft: leftAt != null,
    leftAt,
  };

  if (leftAt == null) return vueGlobale;

  // Sorti AVANT la fin de l'appel ? La marge de 2 s absorbe l'écart normal entre
  // le `leftAt` d'un raccrochage ordinaire et le `endedAt` écrit dans la foulée :
  // sans elle, tout appel normal basculerait sur ce chemin.
  const sortiAvantLaFin =
    finGlobale == null ||
    new Date(leftAt).getTime() < new Date(finGlobale).getTime() - 2000;
  if (!sortiAvantLaFin) return vueGlobale;

  // Un appel qu'on quitte sans l'avoir décroché n'est pas un appel « terminé » :
  // même règle que dans `leave/route.ts`, c'est `answeredAt` qui décide.
  const aParticipe = moi?.joinedAt != null && call.answeredAt != null;
  if (!aParticipe) {
    return { status: "NO_ANSWER", endedAt: leftAt, durationSec: null, hasLeft: true, leftAt };
  }

  const debut =
    new Date(call.answeredAt).getTime() > new Date(moi.joinedAt).getTime()
      ? call.answeredAt
      : moi.joinedAt;
  // Plancher à 1 s, jamais 0 ni nul : `libelleAppel` lit un ENDED sans durée
  // comme « personne n'a décroché » et afficherait « Appel manqué » à quelqu'un
  // qui a bel et bien conversé, simplement très brièvement.
  const duree = dureeEntre(debut, leftAt);
  return {
    status: "ENDED",
    endedAt: leftAt,
    durationSec: Math.max(duree ?? 0, 1),
    hasLeft: true,
    leftAt,
  };
}

/**
 * Construit l'objet d'appel tel que le client l'attend, POUR UN DESTINATAIRE.
 *
 * ⚠️ Le résultat n'est pas le même pour tout le monde, et c'est toute la
 * différence avec un message. Un message est identique pour chacun, il se
 * diffuse tel quel ; un appel est sortant pour l'un et entrant pour l'autre,
 * son libellé et son correspondant en dépendent. Il faut donc appeler cette
 * fonction une fois PAR destinataire, jamais sérialiser une seule charge à
 * diffuser à tous.
 *
 * @param call        appel Prisma, avec `participants` (incluant `user`)
 * @param conv        conversation ({ isGroup, name }) ou nul pour un direct
 * @param pourUserId  destinataire du point de vue duquel on formule
 */
export function serialiseAppelPour(call, conv, pourUserId) {
  const isOutgoing = call.initiatorId === pourUserId;
  const isGroup = conv?.isGroup ?? false;
  const others = (call.participants ?? []).filter((p) => p.userId !== pourUserId);
  const peer = others[0]?.user;
  const peerName = isGroup
    ? (conv?.name ?? "Groupe")
    : (peer ? nomAffichage(peer) : null) ?? "Inconnu";

  // `status`, `endedAt` et `durationSec` sont ceux de CE participant, pas ceux
  // de l'appel : après un transfert, celui qui a passé la main est sorti alors
  // que les deux autres conversent encore. Voir `vueDuParticipant`.
  const vue = vueDuParticipant(call, pourUserId);

  return {
    id: call.id,
    convId: call.convId,
    type: call.type,
    status: vue.status,
    // Statut brut de l'appel, conservé pour le diagnostic et pour un client qui
    // aurait besoin de savoir que la conversation se poursuit sans lui.
    callStatus: call.status,
    hasLeft: vue.hasLeft,
    leftAt: vue.leftAt,
    isOutgoing,
    callerId: call.initiatorId,
    isGroup,
    peerName,
    peerNumber: isGroup ? null : (peer?.publicNumber ?? null),
    peerAvatarUrl: isGroup ? null : (peer?.avatarUrl ?? null),
    participantCount: (call.participants ?? []).length,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: vue.endedAt,
    durationSec: vue.durationSec,
    ...libelleAppel(vue.status, isOutgoing, vue.durationSec),
  };
}

/// Statuts qui closent définitivement un appel.
export const STATUTS_TERMINAUX = ["ENDED", "REJECTED", "MISSED", "NO_ANSWER", "BUSY"];
