import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// POST /api/users/:id/exclude — exclut ou restaure un utilisateur.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const targetId = (await ctx.params).id;
  const { action } = await req.json(); // "exclude" ou "restore"

  if (targetId === userId) {
    return fail("Impossible de s'exclure soi-même", 400, "SELF");
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  const exclus = action === "exclude" ? 1 : 0;
  await prisma.user.update({
    where: { id: targetId },
    data: { exclus },
  });

  return ok({
    message: exclus === 1 ? "Utilisateur exclu" : "Utilisateur restauré",
    id: targetId,
    exclus,
  });
});
