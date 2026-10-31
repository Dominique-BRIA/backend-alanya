import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { peutVoirStatutsDe } from "@/lib/statut-visibilite";
import { statutLivreA } from "@/lib/gestion/statut-bienvenue";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

/**
 * POST / DELETE /api/statuses/:id/like — aimer un statut, ou ne plus l'aimer
 * (01/11/2026, repris d'Alanya).
 *
 * Le « J'aime » est porté par la VUE : aimer vaut aussi « vu ». Mêmes règles
 * de visibilité que la vue — un statut qu'on n'a pas le droit de voir ne
 * s'aime pas. Son propre statut ne s'aime pas non plus.
 *
 * L'auteur l'apprend en direct (`statut_aime`) : son compteur bouge, et le
 * cœur apparaît dans la liste de ses vues.
 */
async function basculer(userId: string, id: string, aime: boolean) {
  const status = await prisma.status.findUnique({ where: { id } });
  if (!status || status.expiresAt < new Date()) {
    return fail("Statut introuvable ou expiré", 404, "NOT_FOUND");
  }
  if (status.userId === userId) {
    return fail("On n'aime pas son propre statut", 400, "OWN_STATUS");
  }
  if (!(await peutVoirStatutsDe(userId, status.userId)) && !(await statutLivreA(userId, status.id))) {
    return fail("Statut introuvable ou expiré", 404, "NOT_FOUND");
  }
  await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId: id, viewerId: userId } },
    create: { statusId: id, viewerId: userId, liked: aime, likedAt: aime ? new Date() : null },
    update: { liked: aime, likedAt: aime ? new Date() : null },
  });
  const likesCount = await prisma.statusView.count({ where: { statusId: id, liked: true } });
  void previensDesPersonnes({
    personnes: [status.userId],
    type: "statut_aime",
    donnees: { statusId: id, userId, liked: aime, likesCount },
  });
  return ok({ liked: aime, likesCount });
}

export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  return basculer(userId, id, true);
});

export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  return basculer(userId, id, false);
});
