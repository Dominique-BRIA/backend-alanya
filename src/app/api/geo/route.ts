import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { positionSchema } from "@/lib/validation";
import {
  INTERVALLE_RELEVE_MIN,
  RELEVE_PERIME_MS,
  enregistreReleve,
} from "@/lib/geo";

/**
 * POST /api/geo — dépose un relevé de position.
 *
 * Alimenté par le MOBILE uniquement : le web n'appelle pas cette route, la
 * position d'un navigateur n'ayant pas le même sens ni la même fiabilité que
 * celle d'un téléphone. Rien ne l'interdit techniquement — l'authentification
 * est la même — mais aucun client web ne l'appelle.
 *
 * Le serveur décide s'il s'agit d'un nouveau lieu ou de la prolongation du
 * précédent ; le téléphone se contente d'envoyer ce qu'il lit.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  /*
   * Cadence attendue : un relevé toutes les cinq minutes, soit 12 par heure.
   * Le plafond est volontairement TRÈS large — un téléphone revenu en ligne
   * vide sa file d'un coup, et le refuser perdrait des relevés légitimes. Il ne
   * sert qu'à borner un client déréglé qui enverrait en boucle.
   */
  const rl = rateLimit(`geo:${userId}`, 60, 60_000);
  if (!rl.allowed) {
    return fail("Trop de relevés de position", 429, "RATE_LIMITED");
  }

  const { lat, lon, collectedAt } = positionSchema.parse(await req.json());

  const maintenant = new Date();
  let releveA = collectedAt ? new Date(collectedAt) : maintenant;

  // Une horloge de téléphone peut avancer. Un relevé « du futur » se placerait
  // en tête et empêcherait tous les suivants de repousser quoi que ce soit —
  // la position resterait figée jusqu'à ce que l'heure réelle le rattrape.
  if (releveA > maintenant) releveA = maintenant;

  if (maintenant.getTime() - releveA.getTime() > RELEVE_PERIME_MS) {
    return fail("Relevé trop ancien", 422, "STALE_POSITION");
  }

  const resultat = await enregistreReleve(userId, lat, lon, releveA);

  return ok({
    collectTime: resultat.collectTime,
    intervalleMin: INTERVALLE_RELEVE_MIN,
  });
});
