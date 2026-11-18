import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { avatarPublicUrl } from "@/lib/avatar";
import { etatPourCompte, groupeDuCode, type ApercuLien } from "@/lib/groupe-adhesion";

/**
 * GET /api/groupes/lien/:code — ce que montre le lien d'un groupe AVANT de
 * confirmer (18/11/2026) : nom, photo, description, nombre de membres, privé
 * ou public, et ce que le lien ferait pour ce compte.
 *
 * 🔒 Pas la liste des membres : qui détient le lien n'est pas encore membre.
 * Un code inconnu (ou renouvelé depuis) rend 404 : la personne apprend que le
 * lien ne vaut plus, sans plus de détail.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { code } = await ctx.params;
  const conv = await groupeDuCode(code);
  if (!conv) return fail("Ce lien de groupe n'est plus valable", 404, "LIEN_INVALIDE");

  const apercu: ApercuLien = {
    convId: conv.id,
    nom: conv.name,
    description: conv.description,
    avatarUrl: avatarPublicUrl(conv.avatarUrl ?? null),
    membres: conv.participants.length,
    acces: conv.acces === "public" ? "public" : "prive",
    chiffre: conv.e2eeActif,
    etat: await etatPourCompte(conv.id, userId, conv.participants),
  };
  return ok(apercu);
});
