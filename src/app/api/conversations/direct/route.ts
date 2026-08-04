import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { nomAffichage } from "@/lib/display-name.mjs";

// POST /api/conversations/direct — cherche ou crée une conversation 1-to-1.
// Body: { targetUserId: string }
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const { targetUserId } = await req.json();

  if (!targetUserId || typeof targetUserId !== "string") {
    return fail("targetUserId manquant", 400, "MISSING_TARGET");
  }
  if (targetUserId === userId) {
    return fail("Conversation avec soi-même impossible", 400, "SELF");
  }

  // Vérifie que l'utilisateur cible existe
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  const conv = await findOrCreateDirectConversation(userId, targetUserId);

  return ok({
    id: conv.id,
    isGroup: false,
    title: nomAffichage(target) ?? "Inconnu",
    avatarUrl: target.avatarUrl ?? null,
  });
});
