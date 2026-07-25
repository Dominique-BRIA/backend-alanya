import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ensureAdmin, TYPE_COMPTE_ADMIN } from "@/lib/roles";

// POST /api/users/:id/exclude — exclut ou restaure un utilisateur.
// Réservé aux administrateurs (User.typeCompte = 9).
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  // Garde-fou admin : seul un administrateur peut exclure/restaurer un compte.
  const forbidden = await ensureAdmin(userId);
  if (forbidden) return forbidden;

  const targetId = (await ctx.params).id;
  const { action, reason } = await req.json(); // action: "exclude" | "restore"

  if (targetId === userId) {
    return fail("Impossible de s'exclure soi-même", 400, "SELF");
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  // Empêche d'exclure un autre administrateur.
  if (target.typeCompte === TYPE_COMPTE_ADMIN) {
    return fail("Impossible d'exclure un administrateur", 403, "TARGET_ADMIN");
  }

  const exclude = action === "exclude";
  const cleanReason =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim().slice(0, 255)
      : null;

  await prisma.user.update({
    where: { id: targetId },
    // Remplit excludeAt/excludeReason à l'exclusion, les efface à la restauration.
    data: exclude
      ? { exclus: 1, excludeAt: new Date(), excludeReason: cleanReason }
      : { exclus: 0, excludeAt: null, excludeReason: null },
  });

  return ok({
    message: exclude ? "Utilisateur exclu" : "Utilisateur restauré",
    id: targetId,
    exclus: exclude ? 1 : 0,
    excludeReason: exclude ? cleanReason : null,
  });
});
