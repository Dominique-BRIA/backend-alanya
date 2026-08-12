// Seuils et périmètre des relevés de position.
//
// ⚠️ CE FICHIER N'IMPORTE RIEN, et c'est délibéré : ces règles s'exécutent
// directement, donc se vérifient au lieu de se relire.
//
// 🗑️ `RAYON_MEME_LIEU_M` et `distanceMetres` ont été RETIRÉS le 11/08/2026.
// Ils servaient à décider « a-t-il bougé ? » pour ne créer une ligne qu'en cas
// de déplacement de plus de 50 m. La règle a changé : **chaque relevé produit
// désormais sa ligne**, sans comparaison. Le regroupement en lieux devient une
// affaire de lecture, faite à l'analyse sur des données complètes, et non une
// décision prise à l'écriture — donc irréversible.

/** Cadence de relevé attendue du mobile, en minutes. */
export const INTERVALLE_RELEVE_MIN = 5;

/**
 * Ce compte est-il concerné par le suivi de position ?
 *
 * ⚠️ LA RÈGLE VIT ICI, CÔTÉ SERVEUR, et le mobile ne fait que l'appliquer : la
 * changer ne demande donc aucun nouvel APK, ni aucune mise à jour à installer
 * sur les téléphones déjà déployés. C'est précisément pour ça qu'elle est une
 * fonction et non une condition écrite dans la route.
 *
 * **Seuls les comptes RATTACHÉS À UNE ENTREPRISE sont suivis** — décision du
 * user, revenue au 11/08/2026 après un court passage par « tout le monde ».
 *
 * Ce n'est pas une prudence gratuite. L'application part en distribution
 * PUBLIQUE sur le Play Store, et un examinateur Google lit « une messagerie
 * grand public qui suit la position de TOUS ses utilisateurs en arrière-plan » :
 * c'est le cas le plus sévèrement examiné, et le plus souvent refusé. La même
 * fonctionnalité limitée aux agents d'une entreprise cliente se justifie comme
 * de la gestion de personnel, ce qu'elle est réellement.
 *
 * Un compte sans `idCompany` est un particulier : l'application se comporte pour
 * lui comme si la fonctionnalité n'existait pas — ni écran de divulgation, ni
 * demande de permission, ni relevé.
 *
 * ⚠️ Un compte qui QUITTE son entreprise cesse d'être suivi au rechargement
 * suivant de son profil : le client relit `suiviPosition` à chaque `/api/me`. Ce
 * qui a déjà été relevé reste en base — la règle décide de la collecte à venir,
 * pas de l'effacement du passé.
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

