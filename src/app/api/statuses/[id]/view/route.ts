import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { peutVoirStatutsDe } from "@/lib/statut-visibilite";
import { statutLivreA } from "@/lib/gestion/statut-bienvenue";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

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
    // Un statut de bienvenue est visible de celui qui l'a reçu, et de lui seul.
    if (!(await peutVoirStatutsDe(userId, status.userId)) && !(await statutLivreA(userId, status.id))) {
      return fail("Statut introuvable ou expiré", 404, "NOT_FOUND");
    }
    /*
     * 🔴 VUES EN DIRECT (01/11/2026) : la PREMIÈRE vue est annoncée à l'auteur,
     * qui voit son compteur bouger sans rouvrir la liste. Une vue rejouée ne
     * l'est pas — elle ne change rien à ce qu'il voit.
     */
    const deja = await prisma.statusView.findUnique({
      where: { statusId_viewerId: { statusId: id, viewerId: userId } },
      select: { id: true },
    });
    if (!deja) {
      await prisma.statusView
        .create({ data: { statusId: id, viewerId: userId } })
        .catch(() => {}); // deux vues simultanées : l'autre a gagné, c'est pareil
      const viewsCount = await prisma.statusView.count({ where: { statusId: id } });
      void previensDesPersonnes({
        personnes: [status.userId],
        type: "statut_vu",
        donnees: { statusId: id, viewerId: userId, viewsCount },
      });
    }
  }

  return ok({ ok: true });
});
