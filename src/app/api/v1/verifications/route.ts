import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { routeV1, type CleAuthentifiee } from "@/lib/developer/authentifier";
import { CODE, STATUT_TROP_DE_REQUETES } from "@/lib/developer/api-contract";
import { emettreCode } from "@/lib/verification/service";

const CHEMIN = "/api/v1/verifications";

/**
 * POST /api/v1/verifications — émet un code de vérification et le livre.
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
 * ⚠️ LE SEUL GARDE-FOU EST LE PLAFOND, et il n'a rien d'optionnel. Il n'y a plus
 * de facturation (21/08/2026) : rien ne rend une rafale de codes coûteuse pour
 * l'appelant, donc rien ne l'en dissuade par accident. Ce qui protège la
 * personne qui reçoit les codes, ce sont les plafonds de `politique.mjs` — par
 * destination et par heure, par IP et par heure — tous deux contrôlés AVANT le
 * tirage du code, plus le plafond par clé de `routeV1`.
 */
export async function POST(req: NextRequest) {
  return routeV1(req, { chemin: CHEMIN, plafondParMinute: 20 }, (cle) => emettre(req, cle));
}

async function emettre(req: NextRequest, cle: CleAuthentifiee): Promise<Response> {
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
    developerId: cle.developerId,
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
}
