import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";

/**
 * LE MODE MAINTENANCE (24/10/2026).
 *
 * L'interrupteur de la console (Paramètres › Maintenance, super-admin), comme
 * chez Alanya2026 — mais RÉEL : chez eux le réglage s'enregistrait sans que
 * rien ne le lise (décision du user : le rendre effectif).
 *
 * Pendant une maintenance, l'application est refusée — connexion, inscription,
 * routes authentifiées — par un 503 `MAINTENANCE`, que le mobile et le web
 * transforment en écran d'attente. La console (`/api/admin/*`, `routeAdmin`)
 * et les fichiers publics restent servis : c'est elle qui lève la maintenance.
 *
 * Le réglage est relu au plus toutes les 10 s par processus : basculer ne
 * coûte pas une lecture de base à chaque requête.
 */
export const CLE_REGLAGES_PLATEFORME = "plateforme.reglages";
const DUREE_CACHE_MS = 10_000;

let cache: { maintenance: boolean; lu: number } | null = null;

export async function enMaintenance(): Promise<boolean> {
  if (cache && Date.now() - cache.lu < DUREE_CACHE_MS) return cache.maintenance;
  let maintenance = false;
  try {
    const r = await prisma.gestionReglage.findUnique({ where: { cle: CLE_REGLAGES_PLATEFORME } });
    maintenance = (r?.valeur as { maintenance?: unknown } | null)?.maintenance === true;
  } catch {
    // La base ne répond pas : ce n'est pas à la maintenance de le dire.
    maintenance = false;
  }
  cache = { maintenance, lu: Date.now() };
  return maintenance;
}

/** Après une bascule depuis la console : effet immédiat dans ce processus. */
export function oublierMaintenance() {
  cache = null;
}

/** Refuse la requête d'un utilisateur de l'application pendant une maintenance. */
export async function refuserSiMaintenance(): Promise<void> {
  if (await enMaintenance()) {
    throw new HttpError(503, "Alanya Work est en maintenance. Réessayez dans quelques instants.", "MAINTENANCE");
  }
}
