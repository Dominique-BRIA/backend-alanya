import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { validateApiKey } from "@/lib/developer/key-service";
import { CODE, STATUT_TROP_DE_REQUETES } from "@/lib/developer/api-contract";
import { emettreCode } from "@/lib/verification/service";

/**
 * POST /api/v1/verifications — émet un code de vérification et le livre.
 *
 * Remplace `POST /api/v1/auth/otp/send`. Le nom change parce que l'usage a
 * changé : ces codes gardent désormais la double authentification d'une
 * plateforme tierce, pas seulement une confirmation d'inscription.
 *
 * Corps : `{ finalite, destination, canal? }`
 *   `finalite`    AUTH_2FA | CREATION_AGENT | VALIDATION_CONTACT
 *   `destination` adresse courriel ou numéro, selon le canal
 *   `canal`       EMAIL | ALANYA — par défaut EMAIL pour AUTH_2FA
 *
 * 🔴 LA RÉPONSE NE CONTIENT JAMAIS LE CODE. C'est nous qui livrons ; un canal
 * « délégué » rendant le code à l'appelant a été envisagé puis écarté, parce
 * qu'il suffisait que son relais journalise les réponses pour publier tous les
 * codes.
 *
 * **Gratuit** : aucun crédit n'est débité. Un solde à zéro ne doit jamais
 * pouvoir empêcher quelqu'un de se connecter.
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
    const canal = body.canal?.toString().trim() || null;

    if (!finalite || !destination) {
      return fail(
        "Les champs finalite et destination sont requis.",
        400,
        CODE.REQUETE_INVALIDE,
      );
    }

    /*
     * L'IP sert le plafond par source. `x-forwarded-for` peut contenir une
     * chaîne de relais : on prend la PREMIÈRE, celle du client d'origine.
     * Falsifiable par l'appelant — c'est pourquoi ce plafond complète celui par
     * destination, qui lui ne l'est pas, au lieu de le remplacer.
     */
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    const r = await emettreCode({
      developerId: keyData.developer.id,
      finalite,
      destination,
      canal,
      ip,
    });

    if (!r.ok) {
      if (r.motif === "TROP_DE_DEMANDES") {
        return fail(
          "Trop de demandes de code pour cette destination. Réessayez plus tard.",
          STATUT_TROP_DE_REQUETES,
          CODE.TROP_DE_REQUETES,
        );
      }
      if (r.motif === "NON_REMIS") {
        // ⚠️ 502 et non 200. C'est LE défaut corrigé : l'ancienne route
        // répondait « envoyé avec succès » quand rien ne partait, et l'appelant
        // n'avait aucun moyen de le savoir.
        return fail(
          "Le code n'a pas pu être remis à cette destination.",
          502,
          CODE.VERIFICATION_NON_REMISE,
        );
      }
      return fail(
        "Finalité, canal ou compte invalide.",
        400,
        CODE.REQUETE_INVALIDE,
      );
    }

    return ok({
      id: r.id,
      finalite,
      canal: r.canal,
      destination,
      expireA: r.expireA.toISOString(),
      livraison: "REMIS",
    });
  } catch (error) {
    console.error("[verifications] émission :", error);
    return fail("Erreur lors de l'émission du code.", 500, CODE.ERREUR_INTERNE);
  }
}
