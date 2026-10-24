import { ok } from "@/lib/http";
import { enMaintenance } from "@/lib/maintenance";

/**
 * GET /api/maintenance — `{ maintenance }`, SANS JETON.
 *
 * L'écran « en maintenance » du mobile et du web l'interroge pour savoir
 * quand reprendre : toutes les autres routes de l'application répondent 503
 * pendant la maintenance, celle-ci jamais.
 */
export async function GET() {
  // Toujours la base : c'est d'ici que l'écran d'attente apprend la levée.
  return ok({ maintenance: await enMaintenance({ frais: true }) });
}
