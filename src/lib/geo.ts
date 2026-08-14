import { prisma } from "@/lib/prisma";

// Les seuils vivent dans `geo-distance.ts`, qui n'importe rien — ce qui permet
// de les exécuter directement pour les vérifier. On les réexporte ici pour que
// les appelants n'aient qu'un seul module à connaître.
export {
  SEUIL_DEPLACEMENT_METRES,
  INTERVALLE_HEARTBEAT_MIN,
  INTERVALLE_RELEVE_MIN,
  RELEVE_PERIME_MS,
  suiviPositionApplicable,
} from "@/lib/geo-distance";

export type ResultatReleve = {
  /** Heure retenue pour ce relevé. */
  collectTime: Date;
};

/**
 * Enregistre un relevé de position.
 *
 * ⚠️ UNE LIGNE PAR RELEVÉ, TOUJOURS — règle changée le 11/08/2026 à la demande
 * du user.
 *
 * La version précédente ne créait une ligne QUE si l'utilisateur s'était
 * déplacé de plus de 50 m ; sinon elle repoussait le `collect_time` de la ligne
 * existante, si bien qu'une ligne décrivait un LIEU et non un relevé. C'était
 * économe, mais ça effaçait l'information : impossible de distinguer « présent
 * en continu pendant deux heures » de « passé deux fois au même endroit », ni de
 * savoir si le téléphone relevait encore.
 *
 * Chaque relevé est désormais conservé tel quel. Le regroupement en lieux et le
 * calcul des durées deviennent une affaire de LECTURE, faite au moment de
 * l'analyse, à partir de données complètes — plutôt qu'une décision prise à
 * l'écriture et impossible à défaire.
 *
 * ⚠️ Conséquence à connaître : environ **288 lignes par jour et par utilisateur
 * suivi** (un relevé toutes les cinq minutes). Une purge par ancienneté devra
 * être prévue le jour où le parc grandira ; l'index `(user_id, collect_time)`
 * la servira aussi bien qu'il sert la lecture.
 *
 * Un relevé sorti d'une file hors ligne s'insère avec SON heure : l'ordre
 * d'arrivée n'a plus d'importance, là où l'ancienne règle pouvait perdre un
 * relevé retardataire.
 */
export async function enregistreReleve(
  userId: string,
  lat: number,
  lon: number,
  releveA: Date,
): Promise<ResultatReleve> {
  await prisma.geo.create({
    data: { userId, lat, lon, collectTime: releveA },
  });
  return { collectTime: releveA };
}
