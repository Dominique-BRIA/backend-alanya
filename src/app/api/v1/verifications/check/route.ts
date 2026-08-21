import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { routeV1, type CleAuthentifiee } from "@/lib/developer/authentifier";
import { CODE } from "@/lib/developer/api-contract";
import { verifierCode } from "@/lib/verification/service";

const CHEMIN = "/api/v1/verifications/check";

/**
 * POST /api/v1/verifications/check — présente un code.
 *
 * Corps : `{ finalite, destination, code }`
 *
 * 🔴 UN SEUL MOTIF DE REFUS EST RENDU, quelle que soit la cause réelle — code
 * faux, expiré, déjà utilisé, ou plafond d'essais atteint. Distinguer
 * « expiré » de « faux » apprendrait à un attaquant qu'il visait le bon code ;
 * distinguer « aucun code pour cette destination » permettrait d'énumérer les
 * comptes. Le motif exact reste dans nos journaux.
 *
 * `essaisRestants` est en revanche rendu : il ne renseigne pas l'attaquant — il
 * sait déjà combien de fois il a essayé — et il permet à l'interface de dire
 * « il vous reste 2 essais » plutôt que de laisser l'utilisateur se faire
 * bloquer sans prévenir.
 *
 * ⚠️ LE PLAFOND DE DÉBIT EST LE PLUS SERRÉ DES CINQ ROUTES (30/min/clé) et il
 * n'est pas décoratif : le plafond d'essais de `politique.mjs` porte sur UN code
 * vivant, tandis que celui-ci porte sur la CLÉ. Sans lui, un porteur de clé
 * pouvait présenter des codes aussi vite que le réseau le permettait, sur autant
 * de destinations qu'il voulait — un code à six chiffres ne tient pas longtemps
 * à ce régime.
 */
export async function POST(req: NextRequest) {
  return routeV1(req, { chemin: CHEMIN, plafondParMinute: 30 }, (cle) => verifier(req, cle));
}

async function verifier(req: NextRequest, cle: CleAuthentifiee): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const finalite = body.finalite?.toString().trim();
  const destination = body.destination?.toString().trim();
  const code = body.code?.toString().trim();

  if (!finalite || !destination || !code) {
    return fail(
      "Les champs finalite, destination et code sont requis.",
      400,
      CODE.REQUETE_INVALIDE,
    );
  }

  const r = await verifierCode({
    developerId: cle.developerId,
    finalite,
    destination,
    code,
  });

  if (!r.ok) {
    // Le motif interne (`r.motif`) est volontairement absent de la réponse.
    console.warn(
      `[verifications] refus ${r.motif} — finalité ${finalite}, destination ${destination}`,
    );
    return ok({ verifie: false, essaisRestants: r.essaisRestants }, 200);
  }

  return ok({ verifie: true });
}
