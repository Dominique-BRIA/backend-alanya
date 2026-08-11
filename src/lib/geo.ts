import { prisma } from "@/lib/prisma";
import { RAYON_MEME_LIEU_M, distanceMetres } from "@/lib/geo-distance";

// Les seuils et la géométrie vivent dans `geo-distance.ts`, qui n'importe rien —
// ce qui permet de les exécuter directement pour les vérifier. On les réexporte
// ici pour que les appelants n'aient qu'un seul module à connaître.
export {
  INTERVALLE_RELEVE_MIN,
  RAYON_MEME_LIEU_M,
  RELEVE_PERIME_MS,
  distanceMetres,
} from "@/lib/geo-distance";

export type ResultatReleve = {
  /** Vrai si une NOUVELLE ligne a été créée (l'utilisateur a changé de lieu). */
  deplace: boolean;
  /** Distance au lieu précédent, nulle au tout premier relevé. */
  distanceM: number | null;
  /** Heure désormais portée par la ligne concernée. */
  collectTime: Date;
};

/**
 * Enregistre un relevé de position.
 *
 * ⚠️ UNE LIGNE = UN LIEU, PAS UN RELEVÉ. C'est la seule lecture que la table
 * permet : elle n'a ni colonne de durée, ni heure d'arrivée. `collect_time` se
 * lit donc « vu à cet endroit jusqu'à », et le temps passé quelque part est
 * l'écart avec le `collect_time` de la ligne précédente.
 *
 * La décision « a-t-il bougé ? » est prise ICI, côté serveur, et non sur le
 * téléphone. Deux raisons : le serveur détient déjà la dernière position connue,
 * et la règle reste modifiable sans reconstruire l'application.
 */
export async function enregistreReleve(
  userId: string,
  lat: number,
  lon: number,
  releveA: Date,
): Promise<ResultatReleve> {
  const derniere = await prisma.geo.findFirst({
    where: { userId },
    orderBy: { collectTime: "desc" },
    select: { idGeo: true, lat: true, lon: true, collectTime: true },
  });

  const creer = async (distanceM: number | null): Promise<ResultatReleve> => {
    await prisma.geo.create({
      data: { userId, lat, lon, collectTime: releveA },
    });
    return { deplace: true, distanceM, collectTime: releveA };
  };

  if (!derniere) return creer(null);

  const distanceM = distanceMetres(
    derniere.lat.toNumber(),
    derniere.lon.toNumber(),
    lat,
    lon,
  );
  if (distanceM > RAYON_MEME_LIEU_M) return creer(distanceM);

  // Même lieu : on repousse l'heure de la ligne existante.
  //
  // ⚠️ JAMAIS EN ARRIÈRE. Un relevé sorti d'une file hors ligne peut être plus
  // ancien que ce qui est déjà écrit ; le laisser passer raccourcirait le séjour
  // au lieu de l'allonger, ce qui est exactement l'inverse du but.
  if (releveA <= derniere.collectTime) {
    return { deplace: false, distanceM, collectTime: derniere.collectTime };
  }
  await prisma.geo.update({
    where: { idGeo: derniere.idGeo },
    data: { collectTime: releveA },
  });
  return { deplace: false, distanceM, collectTime: releveA };
}
