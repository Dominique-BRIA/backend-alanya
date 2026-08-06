import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";

// POST /api/conversations/:id/leave — quitter un groupe.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  const participant = conv.participants.find((p) => p.userId === userId);
  if (!participant) return fail("Vous n'êtes pas membre de ce groupe", 404, "NOT_MEMBER");

  // Nom lu AVANT la suppression : après, le participant n'est plus là.
  const nomPartant = await nomPourAvis(userId);

  // Supprime le participant
  await prisma.participant.delete({
    where: { convId_userId: { convId, userId } },
  });

  // Si le groupe n'a plus de membres, supprime la conversation
  const remaining = await prisma.participant.count({ where: { convId } });
  if (remaining === 0) {
    await prisma.conversation.delete({ where: { id: convId } });
    return ok({ message: "Groupe supprimé (plus de membres)", deleted: true });
  }

  // Départ volontaire : aucun auteur mentionné, contrairement au retrait.
  // Déposé seulement si le groupe existe encore — supprimé, l'avis n'aurait
  // plus de fil où vivre.
  await deposerMessageSysteme(convId, userId, "member_left", { target: nomPartant });

  return ok({ message: "Vous avez quitté le groupe", deleted: false });
});
