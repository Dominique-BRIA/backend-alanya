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
 * OÙ EN EST-ON, DANS LE FUSEAU DE QUELQU'UN D'AUTRE ?
 *
 * Rend le jour de la semaine (0 = dimanche) et les minutes depuis minuit, tels
 * que les vit la personne appelée — pas tels que les vit le serveur.
 *
 * ⚠️ `Intl` FAIT LE TRAVAIL, ET LUI SEUL. Calculer un décalage à la main revient
 * à réimplémenter les fuseaux et les heures d'été, c'est-à-dire à se tromper
 * deux fois par an dans un sens qui ne se remarque pas tout de suite.
 *
 * ⚠️ UN FUSEAU INCONNU NE FAIT PAS TOUT TOMBER. `Intl` lève sur un nom invalide
 * — une ligne écrite par un client bavard, une zone retirée de la base tzdata —
 * et cette fonction est appelée AVANT DE FAIRE SONNER : une exception ici ferait
 * disparaître l'appel. On retombe donc sur UTC, ce qui peut décaler une plage,
 * là où lever ferait perdre l'appel entier.
 */
function maintenantDans(fuseau) {
  let parties;
  try {
    parties = new Intl.DateTimeFormat("en-US", {
      timeZone: fuseau || "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  } catch {
    parties = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  }
  const lire = (type) => parties.find((p) => p.type === type)?.value ?? "";
  const JOURS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // « 24 » à minuit chez certains moteurs : ramené à 0, sinon une plage qui
  // commence à 0 h ne s'ouvrirait jamais.
  const heures = Number(lire("hour")) % 24;
  return {
    jour: JOURS[lire("weekday")] ?? 0,
    minutes: heures * 60 + Number(lire("minute")),
  };
}

/**
 * Une plage programmée couvre-t-elle cet instant ?
 *
 * ⚠️ LA PÉREMPTION SE VÉRIFIE ICI, ET NON PAR UN BALAYAGE. Deux semaines après
 * sa création, la ligne cesse simplement de répondre « oui » — sans qu'aucune
 * tâche n'ait eu à tourner le bon jour.
 */
export function plageCouvreMaintenant(plage) {
  if (new Date(plage.expireLe).getTime() <= Date.now()) return false;
  const ici = maintenantDans(plage.fuseau);
  if (ici.jour !== plage.jour) return false;
  // Début inclus, fin EXCLUE : sans cela, une plage 10 h-12 h et une autre
  // 12 h-14 h se disputeraient la minute de midi.
  return ici.minutes >= plage.debutMin && ici.minutes < plage.finMin;
}

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
 * 🔴 CE QUE RENDRE QUELQUE CHOSE VEUT DIRE : « le répondeur prend cet appel,
 * et le téléphone de l'appelé NE SONNE PAS ». Les deux conditions sont réunies
 * ici et nulle part ailleurs — le répondeur doit répondre (interrupteur allumé,
 * absence posée, ou plage programmée en cours) ET un accueil actif existe pour
 * le faire entendre. `ws-server.mjs` n'a donc rien à réinterpréter : il coupe
 * la sonnerie dès que cette fonction rend un accueil.
 *
 * ⚠️ UN RÉPONDEUR ALLUMÉ SANS ACCUEIL REND `null`, ET DONC ÇA SONNE. C'est le
 * repli voulu — faire taire un téléphone pour servir un silence serait pire
 * qu'un appel manqué — mais c'est un piège pour qui a coché la case sans rien
 * enregistrer. `POST /api/repondeur` refuse pour cette raison d'allumer un
 * répondeur qui n'a rien à dire.
 *
 * Rend aussi le mode, dont l'appelant a besoin : il ne sert plus à décider s'il
 * attend, mais à choisir ce que son écran affiche — « absent jusqu'à 15 h »
 * plutôt que « n'a pas répondu ».
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
  const [compte, plages] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { repondeurActif: true, repondeurJusquA: true },
    }),
    // Seules les lignes encore valables : une programmation périmée n'a pas à
    // être chargée pour être écartée ensuite.
    prisma.repondeurPlage.findMany({
      where: { userId, expireLe: { gt: new Date() } },
      select: {
        id: true,
        jour: true,
        debutMin: true,
        finMin: true,
        fuseau: true,
        expireLe: true,
        accueilId: true,
      },
    }),
  ]);
  if (!compte) return null;

/*
   * DEUX QUESTIONS DIFFÉRENTES, ET LES CONFONDRE CASSE LE MODE PAR DÉFAUT.
   *
   *   • « le répondeur répondra-t-il ? » — oui dès qu'il est allumé ;
   *   • « faut-il sauter la sonnerie ? » — seulement si un RÉGLAGE HORAIRE est
   *     en cours : une absence posée, ou une plage programmée.
   *
   * 🔴 UNE VERSION PRÉCÉDENTE LES AVAIT FUSIONNÉES : rendre un accueil voulait
   * dire « ça ne sonne pas », quel que soit le chemin. Le mode par défaut
   * disparaissait alors — un répondeur simplement allumé coupait la sonnerie, et
   * l'on ne pouvait plus JAMAIS joindre quelqu'un qui en avait un. Or le défaut,
   * c'est justement trente secondes de sonnerie AVANT que le répondeur ne
   * prenne le relais : c'est la seule chance de décrocher.
   *
   * ⚠️ LA PRIORITÉ ENTRE LES DEUX RÉGLAGES HORAIRES EST EXPLICITE : la durée
   * fixe l'emporte sur la programmation. Les deux peuvent se chevaucher — on a
   * programmé « tous les lundis 10 h-12 h », et ce lundi-là on pose en plus
   * « absent trois heures ». La durée fixe est le geste le plus RÉCENT et le
   * plus DÉLIBÉRÉ. Dans les deux cas l'appel ne sonne pas ; c'est l'accueil joué
   * qui diffère, et c'est là que la priorité compte.
   */
  const enDuree = enAbsence(compte.repondeurJusquA);
  const plageActive = enDuree ? null : (plages.find((p) => plageCouvreMaintenant(p)) ?? null);
  const sansSonnerie = enDuree || plageActive !== null;

  // ⚠️ L'ABSENCE PASSE OUTRE L'INTERRUPTEUR. Poser une absence EST une demande
  // explicite, et plus récente que l'état de l'interrupteur : refuser de la
  // servir parce qu'une case est décochée quelque part ferait sonner quelqu'un
  // qui vient de dire qu'il ne répondrait pas.
  if (!sansSonnerie && compte.repondeurActif !== 1) return null;

  /*
   * L'ACCUEIL DE LA PLAGE, QUAND ELLE EN DÉSIGNE UN.
   *
   * ⚠️ ET SEULEMENT SI LA DURÉE FIXE NE COURT PAS : elle est prioritaire, et
   * elle joue l'accueil actif. Sans cette condition, une programmation
   * chevauchant une absence lui volerait sa voix.
   */
  const accueilDeLaPlage = plageActive ? plageActive.accueilId : null;

  const ligne = accueilDeLaPlage
    ? await prisma.repondeurAccueil.findFirst({
        // Le propriétaire est revérifié : l'identifiant vient d'une ligne du
        // compte, mais rien ne coûte moins qu'une condition de plus ici.
        where: { id: accueilDeLaPlage, userId },
        select: { media: MEDIA },
      })
    : null;

  const retenu =
    ligne ??
    (await prisma.repondeurAccueil.findFirst({
      where: { userId, actif: 1 },
      select: { media: MEDIA },
    }));
  if (!retenu) return null;

  return {
/*
     * ⚠️ `sansSonnerie` EST CE QUI COMPTE POUR `ws-server.mjs` : il coupe la
     * sonnerie sur ce champ, et sur lui seul. Il n'a rien à réinterpréter.
     *
     * `mode` ne sert qu'au LIBELLÉ de l'écran appelant — « absent jusqu'à 15 h »
     * plutôt que « n'a pas répondu ». Il voyage avec la trame au lieu d'être
     * deviné à l'arrivée.
     *
     * `absence` reste rendu sous son ancien nom : des clients déjà déployés le
     * lisent, et le retirer les rendrait muets sans rien améliorer.
     */
    sansSonnerie,
    absence: sansSonnerie,
    mode: enDuree ? "duree" : plageActive ? "plage" : "defaut",
    media: { ...retenu.media, url: `/api/media/${retenu.media.id}` },
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
  /*
   * ⚠️ « ACTIF » NE SUFFIT PLUS : une plage programmée peut désigner un AUTRE
   * accueil que celui de tous les jours. Il se joue alors à l'appelant, et
   * devait donc s'ouvrir pour lui — sans cette seconde condition, un lundi
   * matin, l'accueil programmé répondait 403 pendant que celui de tous les
   * jours, lui, passait. Un silence un jour sur sept.
   */
  const accueil = await prisma.repondeurAccueil.findFirst({
    where: {
      mediaId,
      OR: [{ actif: 1 }, { plages: { some: { expireLe: { gt: new Date() } } } }],
    },
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

/**
 * Ce compte a-t-il un accueil à faire entendre ?
 *
 * 🔴 ALLUMER UN RÉPONDEUR MUET EST LE PIÈGE QUI SE LIT COMME UNE PANNE. Quand
 * le répondeur prend un appel, il COUPE la sonnerie — mais `accueilPourAppelant`
 * ne rend quelque chose que s'il a un accueil actif à servir. Sans accueil, elle
 * rend `null`, le téléphone sonne comme avant, et l'utilisateur qui vient
 * d'allumer conclut que la fonction ne marche pas. Elle marche : elle n'a rien
 * à dire.
 *
 * ⚠️ LA RÈGLE VIT ICI PARCE QUE TROIS CHEMINS L'ALLUMENT : l'interrupteur,
 * l'absence et les plages programmées. Elle a vécu un temps dans la seule route
 * `/api/repondeur`, et les plages — écrites plus tard, dans un autre fichier —
 * ont rouvert le piège que les deux autres fermaient avec soin.
 */
export async function aUnAccueil(prisma, userId) {
  const accueil = await prisma.repondeurAccueil.findFirst({
    where: { userId, actif: 1 },
    select: { id: true },
  });
  return accueil !== null;
}
