import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { UnauthorizedError } from "@/lib/auth-context";
import { publierSiProgramme } from "@/modules/media/publication-differee";
import {
  assembler,
  envoiParJetonOuProprietaire,
  etatEnvoi,
} from "@/modules/media/envois-morceaux";

type Contexte = { params: Promise<{ id: string }> };

/**
 * POST /api/media/envois/:id/terminer — relance l'assemblage.
 *
 * ⚠️ PAS UNE ÉTAPE OBLIGATOIRE : le dernier morceau assemble déjà tout seul.
 * C'est un FILET, pour le cas où cet assemblage a échoué (stockage
 * injoignable un instant) alors que tous les morceaux sont là — sans lui, il
 * faudrait renvoyer un morceau pour le redéclencher. Il relance aussi une
 * publication différée restée en attente.
 */
export async function POST(req: NextRequest, ctx: Contexte) {
  try {
    const { id } = await ctx.params;
    const envoi = await envoiParJetonOuProprietaire(req, id);
    if (envoi.statut !== "termine") {
      const etat = await etatEnvoi(envoi);
      if (etat.manquants.length > 0) {
        return fail(`${etat.manquants.length} morceau(x) manquant(s)`, 409, "MORCEAUX_MANQUANTS");
      }
      await assembler(envoi.id);
    } else if (envoi.publicationEtat === "attente") {
      // Assemblé, mais la publication n'a pas eu lieu (serveur arrêté entre
      // les deux, ou erreur passagère) : on la relance.
      await publierSiProgramme(envoi.id);
    }
    const apres = await envoiParJetonOuProprietaire(req, id);
    return ok(await etatEnvoi(apres));
  } catch (err) {
    if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
    return handleError(err);
  }
}
