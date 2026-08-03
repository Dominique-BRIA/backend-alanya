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
    : (peer?.pseudo ?? peer?.publicNumber ?? "Inconnu");
  const durationSec =
    call.answeredAt && call.endedAt
      ? Math.round((new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000)
      : null;

  return {
    id: call.id,
    convId: call.convId,
    type: call.type,
    status: call.status,
    isOutgoing,
    callerId: call.initiatorId,
    isGroup,
    peerName,
    peerNumber: isGroup ? null : (peer?.publicNumber ?? null),
    peerAvatarUrl: isGroup ? null : (peer?.avatarUrl ?? null),
    participantCount: (call.participants ?? []).length,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSec,
    ...libelleAppel(call.status, isOutgoing, durationSec),
  };
}

/// Statuts qui closent définitivement un appel.
export const STATUTS_TERMINAUX = ["ENDED", "REJECTED", "MISSED", "NO_ANSWER", "BUSY"];
