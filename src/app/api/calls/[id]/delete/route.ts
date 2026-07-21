import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// DELETE /api/calls/:id/delete — supprime un appel de l'historique.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const callId = (await ctx.params).id;

  // Vérifie que l'utilisateur est participant de cet appel
  const participant = await prisma.callParticipant.findFirst({
    where: { callId, userId },
  });
  if (!participant) return fail("Appel introuvable", 404, "NOT_FOUND");

  // Supprime les participants et l'appel
  await prisma.callParticipant.deleteMany({ where: { callId } });
  await prisma.call.delete({ where: { id: callId } });

  return ok({ message: "Appel supprimé", id: callId });
});
