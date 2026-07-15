import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// DELETE /api/conversations/:convId/messages/:messageId?scope=everyone|me
// Repli REST quand le WebSocket n'est pas disponible (la notification temps réel
// est gérée par le serveur WS pour le scope "everyone").
export const DELETE = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const scope = req.nextUrl.searchParams.get("scope") ?? "me";
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");

    if (scope === "everyone") {
      // Seul l'expéditeur peut supprimer pour tout le monde.
      if (message.senderId !== userId) {
        return fail("Seul l'expéditeur peut supprimer ce message pour tous", 403, "FORBIDDEN");
      }
      // Marque le message comme supprimé : efface le contenu, détache les médias.
      await prisma.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), content: null },
      });
      await prisma.mediaFile.updateMany({
        where: { messageId },
        data: { messageId: null },
      });
      return ok({ deleted: true, scope: "everyone", messageId });
    }

    // scope = "me" : masque le message pour cet utilisateur uniquement.
    await prisma.messageHide.upsert({
      where: { userId_messageId: { userId, messageId } },
      create: { userId, messageId },
      update: {},
    });
    return ok({ deleted: true, scope: "me", messageId });
  },
);
