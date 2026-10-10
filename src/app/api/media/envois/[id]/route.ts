import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { UnauthorizedError } from "@/lib/auth-context";
import {
  abandonnerEnvoi,
  envoiParJetonOuProprietaire,
  etatEnvoi,
} from "@/modules/media/envois-morceaux";

type Contexte = { params: Promise<{ id: string }> };

function erreur(err: unknown) {
  if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
  return handleError(err);
}

/**
 * GET /api/media/envois/:id — où en est l'envoi : morceaux reçus, morceaux
 * MANQUANTS, et le média une fois assemblé.
 *
 * C'est ce que relit un appareil après une coupure ou un redémarrage, pour ne
 * renvoyer que ce qui manque. Jeton d'envoi OU jeton d'accès du propriétaire.
 */
export async function GET(req: NextRequest, ctx: Contexte) {
  try {
    const { id } = await ctx.params;
    const envoi = await envoiParJetonOuProprietaire(req, id);
    return ok(await etatEnvoi(envoi));
  } catch (err) {
    return erreur(err);
  }
}

/**
 * DELETE /api/media/envois/:id — l'utilisateur renonce. Le fichier partiel est
 * effacé tout de suite, sans attendre l'expiration.
 */
export async function DELETE(req: NextRequest, ctx: Contexte) {
  try {
    const { id } = await ctx.params;
    const envoi = await envoiParJetonOuProprietaire(req, id);
    await abandonnerEnvoi(envoi);
    return ok({ supprime: true });
  } catch (err) {
    return erreur(err);
  }
}
