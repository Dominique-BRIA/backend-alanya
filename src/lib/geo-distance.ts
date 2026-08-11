// Géométrie et seuils des relevés de position.
//
// ⚠️ CE FICHIER N'IMPORTE RIEN, et c'est délibéré. La règle « a-t-il bougé ? »
// tient tout entière dans une distance et un seuil : une erreur ici serait
// silencieuse — aucun plantage, simplement des lieux jamais regroupés, ou tous
// confondus. Sans dépendance, ces quelques lignes s'exécutent directement, donc
// se vérifient au lieu de se relire.

/**
 * Rayon en deçà duquel deux relevés désignent LE MÊME LIEU.
 *
 * ⚠️ SANS CE RAYON, LA FONCTIONNALITÉ NE PEUT PAS FONCTIONNER. « L'utilisateur
 * n'a pas bougé » ne peut pas être une égalité de coordonnées : la colonne est
 * en `NUMERIC(10,7)`, soit environ un centimètre de résolution, alors que deux
 * relevés GPS d'un téléphone POSÉ SUR UNE TABLE diffèrent de 5 à 20 mètres. Une
 * comparaison exacte n'aurait jamais été vraie : on aurait inséré une ligne à
 * chaque relevé, et la branche « il n'a pas bougé » n'aurait jamais servi.
 *
 * 50 m = un immeuble compte pour un seul lieu. C'est une décision MÉTIER, pas
 * technique, et elle vit ici, à un seul endroit, côté serveur : la changer ne
 * demande aucun nouvel APK.
 */
export const RAYON_MEME_LIEU_M = 50;

/** Cadence de relevé attendue du mobile, en minutes. */
export const INTERVALLE_RELEVE_MIN = 5;

/**
 * Ce compte est-il concerné par le suivi de position ?
 *
 * ⚠️ LA RÈGLE VIT ICI, CÔTÉ SERVEUR, et le mobile ne fait que l'appliquer : la
 * changer ne demande donc aucun nouvel APK, ni aucune mise à jour à installer
 * sur les téléphones déjà déployés.
 *
 * Seuls les comptes **rattachés à une entreprise** sont suivis. Ce n'est pas une
 * prudence gratuite : l'application est destinée au Play Store, et un
 * examinateur Google lit « une messagerie grand public qui suit la position de
 * tous ses utilisateurs en arrière-plan » — le cas le plus sévèrement examiné,
 * et le plus souvent refusé. La même fonctionnalité limitée aux agents d'une
 * entreprise cliente se justifie comme de la gestion de personnel, ce qu'elle
 * est réellement.
 *
 * Un compte sans `idCompany` est un particulier : il n'a rien à voir avec un
 * centre d'appels, et l'application se comporte pour lui comme si la
 * fonctionnalité n'existait pas.
 */
export function suiviPositionApplicable(idCompany: number | null | undefined): boolean {
  return idCompany != null;
}

/**
 * Au-delà, un relevé est jugé périmé et refusé.
 *
 * Le téléphone met ses relevés en file quand il est hors ligne : ils peuvent
 * donc arriver en retard, ce qui est normal. Un relevé vieux de plus d'un jour
 * ne décrit en revanche plus rien d'utile, et l'accepter fausserait l'ordre des
 * lieux.
 */
export const RELEVE_PERIME_MS = 24 * 60 * 60 * 1000;

/**
 * Distance en mètres entre deux points, par la formule de haversine.
 *
 * Exacte plutôt qu'approchée : à l'échelle où l'on travaille, une approximation
 * plane suffirait, mais elle se dégrade avec la latitude et n'économise que
 * quelques opérations sur un chemin appelé une fois toutes les cinq minutes.
 */
export function distanceMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const RAYON_TERRE_M = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  // `Math.min(1, …)` : l'arrondi flottant peut faire dépasser 1 pour deux points
  // confondus, et `asin` renverrait alors NaN — donc une distance NaN, qui
  // comparée au rayon donne `false` et ferait croire à un non-déplacement.
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
