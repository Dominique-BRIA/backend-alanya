import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { estAdminDuGroupe } from "@/lib/groupe-droits.mjs";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

/**
 * GET /api/conversations/:id/demandes — la liste d'attente d'un groupe
 * (18/11/2026). Les admins seuls : un simple membre n'a pas à savoir qui a
 * demandé, ni qui a été refusé.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        where: MEMBRE_ACTIF,
        select: { userId: true, role: true },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");
  if (!estAdminDuGroupe(conv.participants, userId)) {
    return fail("Seul un admin voit les demandes", 403, "NOT_ADMIN");
  }

  const demandes = await prisma.demandeAdhesion.findMany({
    where: { convId, statut: "attente" },
    orderBy: { creeLe: "asc" },
    include: {
      user: { select: { id: true, pseudo: true, publicNumber: true, avatarUrl: true } },
    },
  });
  return ok({
    demandes: demandes.map((d) => ({
      id: d.id,
      userId: d.userId,
      pseudo: nomAffichage(d.user),
      publicNumber: d.user.publicNumber,
      avatarUrl: avatarPublicUrl(d.user.avatarUrl ?? null),
      creeLe: d.creeLe,
    })),
  });
});
