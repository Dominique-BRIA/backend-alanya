import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

// PATCH /api/conversations/:convId/messages/:messageId — modifier un message.
// Repli REST (la diffusion temps réel est gérée par le serveur WS). Seul
// l'expéditeur, uniquement un message TEXTE non supprimé.
export const PATCH = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const { content } = await req.json();
    if (typeof content !== "string" || !content.trim()) {
      return fail("Contenu vide", 400, "EMPTY");
    }

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");
    if (message.senderId !== userId) {
      return fail("Seul l'expéditeur peut modifier ce message", 403, "FORBIDDEN");
    }
    if (message.deletedAt) return fail("Message supprimé", 400, "DELETED");
    if (message.type !== "TEXT") {
      return fail("Seuls les messages texte sont modifiables", 400, "NOT_TEXT");
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content: content.trim(), editedAt: new Date() },
    });
    return ok({ id: updated.id, content: updated.content, editedAt: updated.editedAt });
  },
);

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
