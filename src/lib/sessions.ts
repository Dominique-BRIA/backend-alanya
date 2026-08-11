import { prisma } from "@/lib/prisma";
import { supprimeJetonsPushDAppareils } from "@/lib/push";

/**
 * Un compte s'ouvre sur au plus DEUX appareils : un mobile et un poste.
 *
 * Les valeurs de `Appareil.typeDevice` viennent du référentiel équipe :
 * 0 = web, 1 = Android, 2 = iOS, 3 = bureau. Le « bureau » rejoint la famille
 * des postes, décision du 11/08/2026 : c'est une machine devant laquelle on
 * s'assoit, pas un appareil qu'on a sur soi. Un utilisateur peut donc travailler
 * sur son ordinateur tout en gardant son téléphone joignable, ce qui est le cas
 * d'usage réel — mais pas ouvrir son compte sur deux téléphones.
 */
export const TYPES_MOBILE = [1, 2];
export const TYPES_POSTE = [0, 3];

/**
 * Les mêmes familles, dans le vocabulaire de `push_devices.platform`.
 *
 * Deux nomenclatures pour une même notion, et c'est l'existant : le registre des
 * appareils vient du référentiel équipe et compte en entiers, les jetons de
 * notification sont à nous et comptent en chaînes. On les fait correspondre ici,
 * à un seul endroit, plutôt que de les traduire à chaque appel.
 *
 * Le « bureau » n'a pas de plateforme à lui : une application de bureau reçoit
 * ses notifications comme le web.
 */
export const PLATEFORMES_MOBILE = ["android", "ios"];
export const PLATEFORMES_POSTE = ["web"];

export type FamilleAppareil = "mobile" | "poste";

export function familleDeAppareil(typeDevice: number | null | undefined): FamilleAppareil {
  return TYPES_MOBILE.includes(Number(typeDevice)) ? "mobile" : "poste";
}

/** Raison inscrite dans `RefreshToken.revokedReason` par l'éviction. */
export const RAISON_EVICTION = "evicted";

/**
 * Combien de sessions simultanées cette famille tolère-t-elle ?
 *
 * `users.appareil_total` compte **le mobile ET le web** : réglé à 2 — le défaut —
 * il autorise un téléphone et un navigateur. Le mobile reste plafonné à 1 quoi
 * qu'il arrive ; tout ce qui dépasse va au web.
 *
 * ⚠️ Plancher à 1 pour le web, et c'est une conséquence directe du choix
 * « on déconnecte le plus ancien » plutôt que « on refuse la nouvelle
 * connexion ». Un compte réglé à 1 devrait, à la lettre, n'avoir aucun accès
 * web ; mais nous sommes appelés APRÈS l'authentification, quand il est trop
 * tard pour refuser. Lui rendre une session vaut mieux que d'en ouvrir une qui
 * s'évincerait elle-même. Un vrai « mobile uniquement » demanderait de refuser
 * la connexion, donc un autre parcours — voir l'option B écartée le 11/08/2026.
 */
export function limiteDeLaFamille(
  famille: FamilleAppareil,
  appareilTotal: number,
): number {
  if (famille === "mobile") return 1;
  return Math.max(1, (appareilTotal || 2) - 1);
}

/**
 * De quelle famille est l'appareil qui se connecte ?
 *
 * Le client l'annonce, mais le champ est facultatif : un client plus ancien ne
 * l'envoie pas. On retombe alors sur ce que le registre sait déjà de cet
 * appareil — il y figure dès sa deuxième connexion. `null` quand personne ne
 * sait, et l'appelant n'évince alors rien.
 */
export async function typeDeviceDeLAppareil(
  userId: string,
  deviceId: string | undefined,
  annonce: number | undefined,
): Promise<number | null> {
  if (annonce !== undefined) return annonce;
  if (!deviceId) return null;
  const connu = await prisma.appareil.findUnique({
    where: { cookiesWebId_alanyaId: { cookiesWebId: deviceId, alanyaId: userId } },
    select: { typeDevice: true },
  });
  return connu?.typeDevice ?? null;
}

/**
 * Ferme les autres sessions de la MÊME FAMILLE que l'appareil qui se connecte.
 *
 * ⚠️ À APPELER AVANT `issueTokenPair`, jamais après : la révocation touche les
 * jetons du compte, et le couple qu'on est en train d'émettre serait emporté
 * avec les autres.
 *
 * Deux effets, et les deux sont nécessaires :
 *
 *  - `Appareil.destroy = 1` — ce que l'utilisateur VOIT dans « appareils
 *    connectés ». Insuffisant seul : ce champ n'ouvre ni ne ferme l'accès, et
 *    `POST /api/appareils` le remet à 0 à chaque démarrage ;
 *  - les jetons de rafraîchissement sont révoqués — c'est ce qui coupe
 *    RÉELLEMENT l'accès. La coupure n'est pas instantanée : le jeton d'accès est
 *    un JWT sans état, valide jusqu'à 15 minutes. C'est une limite du format, pas
 *    un défaut à corriger ici ; l'événement temps réel sert à accélérer le cas
 *    courant.
 *
 * @returns les identifiants d'appareil évincés, pour que le client qui vient
 *   d'ouvrir la session puisse les annoncer au serveur temps réel. L'API et
 *   `ws-server.mjs` sont deux process sans canal entre eux : c'est le client,
 *   qui tient déjà une connexion authentifiée, qui fait le lien.
 */
export async function fermeLesAutresSessions(
  userId: string,
  deviceId: string | undefined,
  typeDevice: number | null | undefined,
  appareilTotal: number,
): Promise<string[]> {
  /*
   * Famille inconnue → ON N'ÉVINCE PERSONNE.
   *
   * Le cas se produit à la toute première connexion d'un appareil qui n'a pas
   * encore été enregistré et dont le client n'annonce pas son type. Deviner
   * reviendrait à choisir une famille au hasard et à déconnecter un appareil qui
   * n'avait rien à voir. Une session de trop se corrige à la connexion suivante ;
   * un utilisateur éjecté de son ordinateur parce qu'il a ouvert son téléphone
   * ne se corrige pas.
   */
  if (typeDevice === null || typeDevice === undefined) return [];

  const famille = familleDeAppareil(typeDevice);
  const typesDeLaFamille = famille === "mobile" ? TYPES_MOBILE : TYPES_POSTE;
  const limite = limiteDeLaFamille(famille, appareilTotal);

  const familleEntiere = await prisma.appareil.findMany({
    where: { alanyaId: userId, typeDevice: { in: typesDeLaFamille } },
    select: { appareilId: true, cookiesWebId: true, lastLogin: true },
  });

  /*
   * L'exclusion de l'appareil courant se fait ICI, en JavaScript, et non dans le
   * `where`.
   *
   * `{ cookiesWebId: { not: deviceId } }` porte sur une colonne NULLABLE, et la
   * comparaison SQL avec NULL ne rend ni vrai ni faux : selon la traduction que
   * Prisma en fait, les appareils sans identifiant seraient inclus ou écartés en
   * silence. Or ce sont précisément les lignes les plus anciennes du registre.
   * Un filtre explicite ne laisse pas la question ouverte, et le coût est nul —
   * un compte compte quelques dizaines d'appareils au plus.
   */
  const autres = familleEntiere.filter((a) => a.cookiesWebId !== deviceId);

  /*
   * ⚠️ ON NE COMPTE PAS LES LIGNES DU REGISTRE, ON COMPTE LES SESSIONS VIVANTES.
   *
   * `Appareil` accumule sans jamais se vider : un navigateur privé, un
   * changement de navigateur, un vidage de cache créent chacun une ligne qui
   * reste. En production, un compte compte 17 postes enregistrés pour une seule
   * session réelle, un autre 12. Compter ces lignes rendrait un utilisateur
   * « à la limite » à cause de fantômes, et lui ferait perdre une vraie session
   * au profit d'une entrée morte.
   *
   * La seule mesure juste est le jeton de rafraîchissement encore valide : c'est
   * lui, et lui seul, qui donne un accès. Les appareils sans jeton vivant ne
   * concourent pas pour une place et ne sont pas touchés.
   */
  const sessionsVivantes = await prisma.refreshToken.findMany({
    where: {
      userId,
      revoked: false,
      expiresAt: { gt: new Date() },
      deviceId: { not: null },
    },
    select: { deviceId: true, createdAt: true },
  });
  const vueLe = new Map<string, Date>();
  for (const s of sessionsVivantes) {
    const connu = vueLe.get(s.deviceId!);
    if (!connu || s.createdAt > connu) vueLe.set(s.deviceId!, s.createdAt);
  }

  const concurrents = autres.filter(
    (a) => a.cookiesWebId != null && vueLe.has(a.cookiesWebId),
  );

  /*
   * Du plus RÉCENT au plus ancien, puis on garde les `limite - 1` premiers :
   * l'appareil qui vient de se connecter occupe déjà une place.
   *
   * L'ancienneté se lit sur la session, pas sur `lastLogin` du registre —
   * celui-ci est rafraîchi à chaque démarrage de l'application, y compris par un
   * poste dont la session est morte depuis longtemps.
   */
  concurrents.sort(
    (x, y) =>
      vueLe.get(y.cookiesWebId!)!.getTime() -
      vueLe.get(x.cookiesWebId!)!.getTime(),
  );
  const aEvincer = concurrents.slice(Math.max(0, limite - 1));

  const idsAppareils = aEvincer.map((a) => a.appareilId);
  const idsClients = aEvincer
    .map((a) => a.cookiesWebId)
    .filter((c): c is string => Boolean(c));

  if (idsAppareils.length > 0) {
    await prisma.appareil.updateMany({
      where: { appareilId: { in: idsAppareils } },
      data: { destroy: 1, isOnline: 0 },
    });
  }

  /*
   * Les sessions SANS `device_id` — ouvertes avant que le lien appareil↔session
   * n'existe, ou par un client qui ne l'envoie pas — ne se rattachent à aucune
   * famille. Les laisser vivre laisserait une session dont on ne sait rien
   * contourner la règle.
   *
   * ⚠️ MAIS SEULEMENT QUAND LA LIMITE EST DE 1. Au-delà, une de ces sessions
   * anonymes peut appartenir à un poste qui a parfaitement le droit de rester :
   * la couper reviendrait à déconnecter quelqu'un qui n'était pas de trop. Tant
   * qu'une seule session est permise, tout le reste part de toute façon — le
   * doute est sans conséquence. Dès que plusieurs le sont, il faut savoir, et on
   * ne sait pas.
   *
   * Sans risque pour l'appareil courant : son propre couple n'est émis qu'APRÈS
   * cet appel, et il porte son `device_id`.
   */
  const anonymesAussi = limite <= 1;
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      revoked: false,
      OR: [
        { deviceId: { in: idsClients } },
        ...(anonymesAussi ? [{ deviceId: null }] : []),
      ],
    },
    data: { revoked: true, revokedReason: RAISON_EVICTION },
  });

  /*
   * ⚠️ COUPER AUSSI LES NOTIFICATIONS. Sans cela, l'éviction est incomplète de
   * la façon la plus visible qui soit : le téléphone sortant n'a plus accès à
   * rien, mais continue de faire sonner les appels et d'afficher les messages,
   * parce que l'envoi FCM cible un COMPTE et arrose tous ses jetons. Un appareil
   * qu'on a coupé mais qui sonne encore donne l'impression que rien n'a
   * fonctionné.
   */
  await supprimeJetonsPushDAppareils(
    userId,
    idsClients,
    // Même prudence que ci-dessus : les jetons push sans appareil connu ne
    // partent que si tout part. Au-delà d'une session, on couperait les
    // notifications d'un poste qui reste.
    anonymesAussi ? (famille === "mobile" ? PLATEFORMES_MOBILE : PLATEFORMES_POSTE) : [],
  );

  return idsClients;
}

/**
 * Lève une révocation sur l'appareil qui vient de s'authentifier.
 *
 * ⚠️ SEULE UNE AUTHENTIFICATION NEUVE peut le faire, et c'est pour cela que
 * cette fonction vit ici et n'est appelée que par `login`. `POST /api/appareils`
 * s'en chargeait auparavant — mais cette route s'appelle à chaque démarrage avec
 * un jeton déjà en main, ce qui donnait à un appareil révoqué le pouvoir
 * d'annuler sa propre révocation en redémarrant avant l'expiration de son jeton
 * d'accès.
 *
 * `updateMany` et non `update` : à la toute première connexion d'un appareil, sa
 * ligne n'existe pas encore — elle sera créée par `POST /api/appareils`, avec
 * `destroy = 0` par défaut. Sans ligne, l'opération ne fait simplement rien.
 */
export async function reactiveAppareil(
  userId: string,
  deviceId: string | undefined,
): Promise<void> {
  if (!deviceId) return;
  await prisma.appareil.updateMany({
    where: { alanyaId: userId, cookiesWebId: deviceId, destroy: 1 },
    data: { destroy: 0 },
  });
}
