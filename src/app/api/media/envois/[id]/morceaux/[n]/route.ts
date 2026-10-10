import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { lireIndice } from "@/lib/envoi-morceaux.mjs";
import { envoiParJeton, recevoirMorceau } from "@/modules/media/envois-morceaux";

type Contexte = { params: Promise<{ id: string; n: string }> };

/**
 * PUT|POST /api/media/envois/:id/morceaux/:n — reçoit le morceau `n` (à partir
 * de 0), corps BRUT (application/octet-stream), jeton dans `X-Envoi-Jeton`.
 *
 * Idempotent : renvoyer un morceau déjà reçu le réécrit à l'identique et ne le
 * compte pas deux fois. Le morceau qui complète le fichier rend le média
 * (`termine: true`, `media`).
 *
 * ⚠️ LES DEUX VERBES. PUT est le bon (on dépose une ressource à une adresse
 * connue), mais l'envoi binaire du paquet Android utilise POST par défaut :
 * accepter les deux évite un réglage de plus à oublier côté client.
 */
async function recevoir(req: NextRequest, ctx: Contexte) {
  try {
    const { id, n } = await ctx.params;
    const indice = lireIndice(n);
    if (indice === null) return fail("Numéro de morceau invalide", 400, "MORCEAU_INCONNU");
    const envoi = await envoiParJeton(req, id);
    return ok(await recevoirMorceau(envoi, indice, req.body));
  } catch (err) {
    return handleError(err);
  }
}

export const PUT = recevoir;
export const POST = recevoir;
