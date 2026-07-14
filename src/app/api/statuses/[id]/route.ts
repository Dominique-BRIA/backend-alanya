import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// DELETE /api/statuses/:id — supprime un de ses propres statuts.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const status = await prisma.status.findUnique({ where: { id } });
  if (!status || status.userId !== userId) {
    return fail("Statut introuvable", 404, "NOT_FOUND");
  }

  await prisma.status.delete({ where: { id } });
  return ok({ message: "Statut supprimé" });
});
