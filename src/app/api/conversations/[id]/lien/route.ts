import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { estAdminDuGroupe } from "@/lib/groupe-droits.mjs";
import { codeLienDe, lienGroupe, peutPartagerLien, renouvelerCodeLien } from "@/lib/groupe-adhesion";

async function lireGroupe(convId: string) {
  return prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        where: MEMBRE_ACTIF,
        select: { userId: true, role: true },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
}

/**
 * GET /api/conversations/:id/lien — le lien du groupe et son type (18/11/2026).
 *
 * Partager le lien revient à ajouter des membres : ceux qui peuvent ajouter
 * le voient (les admins, ou tout le monde si « seuls les admins ajoutent »
 * est levé). Le QR code est dessiné par le client à partir du lien.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const conv = await lireGroupe(convId);
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");
  if (!conv.participants.some((p) => p.userId === userId)) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }
  if (!peutPartagerLien(conv, conv.participants, userId)) {
    return fail("Seul un admin peut partager le lien du groupe", 403, "NOT_ADMIN");
  }
  const code = await codeLienDe(convId);
  return ok({ code, lien: lienGroupe(code), acces: conv.acces });
});

/**
 * POST /api/conversations/:id/lien — renouveler le lien (admins). L'ancien
 * lien et l'ancien QR code ne mènent plus nulle part ; les demandes déjà en
 * attente restent.
 */
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const conv = await lireGroupe(convId);
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");
  if (!estAdminDuGroupe(conv.participants, userId)) {
    return fail("Seul un admin peut renouveler le lien", 403, "NOT_ADMIN");
  }
  const code = await renouvelerCodeLien(convId);
  return ok({ code, lien: lienGroupe(code), acces: conv.acces });
});
