import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { validateApiKey } from "@/lib/developer/key-service";
import { CODE } from "@/lib/developer/api-contract";
import { verifierCode } from "@/lib/verification/service";

/**
 * POST /api/v1/verifications/check — présente un code.
 *
 * Remplace `POST /api/v1/auth/otp/verify`.
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
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const customHeader = req.headers.get("X-Api-Key") || "";
    const rawKey = authHeader.replace(/^Bearer\s+/i, "") || customHeader;

    if (!rawKey) return fail("Clé API manquante.", 401, CODE.CLE_MANQUANTE);

    const keyData = await validateApiKey(rawKey);
    if (!keyData || !keyData.developer) {
      return fail("Clé API invalide ou révoquée.", 401, CODE.CLE_INVALIDE);
    }

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
      developerId: keyData.developer.id,
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
  } catch (error) {
    console.error("[verifications] vérification :", error);
    return fail("Erreur lors de la vérification du code.", 500, CODE.ERREUR_INTERNE);
  }
}
