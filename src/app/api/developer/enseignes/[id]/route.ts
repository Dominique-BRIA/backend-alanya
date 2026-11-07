import { type NextRequest } from "next/server";
import { ok, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { supprimerEnseigne } from "@/lib/developer/enseignes";

/**
 * DELETE /api/developer/enseignes/:id — supprime l'enseigne.
 *
 * Son compte Alanya est supprimé comme un compte supprimé depuis
 * l'application, et la base emporte le reste : clés (qui cessent aussitôt de
 * marcher), journal, webhook, codes de vérification. Le compte de la personne
 * n'est pas touché. La console demande confirmation avant d'appeler.
 */
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  try {
    const { id } = await ctx.params;
    await supprimerEnseigne(userId, id);
    return ok({ message: "Enseigne supprimée." });
  } catch (err) {
    return handleError(err);
  }
});
