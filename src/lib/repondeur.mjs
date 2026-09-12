/**
 * LE RÉPONDEUR — quel accueil, et faut-il seulement faire sonner ?
 *
 * Module partagé, et il fallait qu'il le soit : la question se pose à DEUX
 * endroits que tout sépare. L'API la pose quand l'appelant réclame l'accueil
 * après trente secondes de sonnerie ; `ws-server.mjs` la pose AVANT de faire
 * sonner qui que ce soit. Deux processus, deux langages — TypeScript d'un côté,
 * JavaScript de l'autre — et une seule règle, qui ne peut pas vivre en double
 * sans se contredire un jour.
 */

/**
 * Le compte est-il en mode absence à cet instant ?
 *
 * ⚠️ LA COMPARAISON EST FAITE ICI, PAS EN BASE, et c'est ce qui rend le retour
 * au mode par défaut gratuit : il n'y a rien à réveiller quand la date passe.
 * Personne n'a à effacer la colonne — une date dépassée répond « non » d'elle
 * même, et l'utilisateur retrouve ses sonneries sans qu'aucun code ne tourne.
 */
export function enAbsence(jusquA) {
  if (!jusquA) return false;
  return new Date(jusquA).getTime() > Date.now();
}

/** Les colonnes du média qu'un client sait lire. */
const MEDIA = {
  select: { id: true, url: true, mimeType: true, durationMs: true, filename: true },
};

/**
 * L'accueil à jouer à quelqu'un qui appelle `userId`, ou `null`.
 *
 * Rend aussi le mode, dont l'appelant a besoin : en absence, il n'attend pas
 * trente secondes, et son écran ne dit pas la même chose.
 *
 * 🔴 UN SEUL ACCUEIL, DANS LES DEUX MODES — et c'était une complication de trop.
 *
 * Une version précédente permettait d'en désigner un second, réservé à
 * l'absence. L'idée se défendait sur le papier — « je suis en réunion » ne dit
 * pas ce que dit « laissez un message » — mais à l'écran elle donnait un bouton
 * de plus par accueil, dont personne ne pouvait deviner l'effet : le répondeur
 * n'a qu'un message actif, et c'est celui-là qu'on entend. Le mode change QUAND
 * on l'entend, pas LEQUEL. Changer de message, c'est changer l'accueil actif.
 */
export async function accueilPourAppelant(prisma, userId) {
  const compte = await prisma.user.findUnique({
    where: { id: userId },
    select: { repondeurActif: true, repondeurJusquA: true },
  });
  if (!compte) return null;

  const absence = enAbsence(compte.repondeurJusquA);

  // ⚠️ L'ABSENCE PASSE OUTRE L'INTERRUPTEUR. Poser une absence EST une demande
  // explicite, et plus récente que l'état de l'interrupteur : refuser de la
  // servir parce qu'une case est décochée quelque part ferait sonner quelqu'un
  // qui vient de dire qu'il ne répondrait pas.
  if (!absence && compte.repondeurActif !== 1) return null;

  const ligne = await prisma.repondeurAccueil.findFirst({
    where: { userId, actif: 1 },
    select: { media: MEDIA },
  });
  if (!ligne) return null;

  return {
    absence,
    media: { ...ligne.media, url: `/api/media/${ligne.media.id}` },
  };
}

/** Fenêtre pendant laquelle un appel donne droit à entendre l'accueil. */
export const FENETRE_APPEL_MS = 10 * 60 * 1000;

/**
 * AI-JE LE DROIT D'ENTENDRE CE MESSAGE D'ACCUEIL ?
 *
 * 🐛 L'ACCUEIL NE S'EST JAMAIS JOUÉ POUR PERSONNE, ET VOICI POURQUOI.
 *
 * Le fichier appartient à la personne APPELÉE. L'appelant n'en est ni le
 * propriétaire, ni participant d'une conversation où il serait attaché — il
 * n'est attaché à aucun message — ni un avatar, ni un statut. `/api/media/:id`
 * lui répondait donc « Accès refusé ». La route du répondeur servait fidèlement
 * une adresse que le serveur refusait ensuite de délivrer.
 *
 * Rien ne le disait : une balise `<audio>` dont la source répond 403 reste là,
 * muette. On a cherché du côté de la lecture automatique, des permissions du
 * navigateur, du bouton — alors que le son n'arrivait jamais.
 *
 * ⚠️ LA RÈGLE EST LA MÊME QUE CELLE DE `?appel=`, et il faut qu'elle le reste :
 * un appel RÉCENT, que J'AI INITIÉ, resté SANS RÉPONSE, vers la personne dont
 * c'est l'accueil. Sans ces quatre conditions, il suffirait de demander un
 * identifiant de média pour moissonner la voix de n'importe qui.
 */
export async function peutEntendreAccueil(prisma, userId, mediaId) {
  // De qui est-ce l'accueil ACTIF ? Un accueil qui n'est plus actif ne se joue
  // à personne, et n'a donc aucune raison de s'ouvrir.
  const accueil = await prisma.repondeurAccueil.findFirst({
    where: { mediaId, actif: 1 },
    select: { userId: true },
  });
  if (!accueil) return false;
  // On ne s'entend pas soi-même par ce chemin — le propriétaire passe déjà.
  if (accueil.userId === userId) return true;

  const appel = await prisma.call.findFirst({
    where: {
      initiatorId: userId,
      answeredAt: null,
      startedAt: { gt: new Date(Date.now() - FENETRE_APPEL_MS) },
      participants: { some: { userId: accueil.userId } },
    },
    select: { id: true },
  });
  return appel !== null;
}
