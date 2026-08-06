import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { avatarStockage } from "@/lib/avatar";

// PATCH /api/conversations/:id — modifier le nom/avatar d'un groupe.
// Seul un admin peut modifier.
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const body = await req.json();

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  // Vérifie que l'utilisateur est membre et admin (ou premier membre pour les anciens groupes)
  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");
  const hasAdmin = conv.participants.some((p) => p.role === "ADMIN");
  const isFirst = conv.participants[0]?.userId === userId;
  const isAdmin = me.role === "ADMIN" || (!hasAdmin && isFirst);
  if (!isAdmin) return fail("Seul un admin peut modifier le groupe", 403, "NOT_ADMIN");

  const data: any = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.avatarUrl !== undefined) data.avatarUrl = avatarStockage(body.avatarUrl);

  if (Object.keys(data).length === 0) {
    return fail("Aucune modification", 400, "NO_CHANGES");
  }

  await prisma.conversation.update({
    where: { id: convId },
    data,
  });

  return ok({ message: "Groupe mis à jour", id: convId });
});
