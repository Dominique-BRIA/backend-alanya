import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { peutVoirStatutsDe } from "@/lib/statut-visibilite";

// POST /api/statuses/:id/view — marque un statut comme vu (sauf le sien).
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const status = await prisma.status.findUnique({ where: { id } });
  if (!status || status.expiresAt < new Date()) {
    return fail("Statut introuvable ou expiré", 404, "NOT_FOUND");
  }

  // On n'enregistre pas de vue sur ses propres statuts.
  if (status.userId !== userId) {
    // ⚠️ MÊME RÈGLE QUE LE FIL. Sans ce contrôle, quelqu'un hors audience qui
    // devine un identifiant se compte comme lecteur dans le « Vu par » de
    // l'auteur — un statut qu'il n'a jamais eu le droit d'ouvrir.
    if (!(await peutVoirStatutsDe(userId, status.userId))) {
      return fail("Statut introuvable ou expiré", 404, "NOT_FOUND");
    }
    await prisma.statusView.upsert({
      where: { statusId_viewerId: { statusId: id, viewerId: userId } },
      create: { statusId: id, viewerId: userId },
      update: {},
    });
  }

  return ok({ ok: true });
});
