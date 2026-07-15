import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { z } from "zod";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

const forwardSchema = z.object({
  messageId: z.string().uuid(),
  targetConvIds: z.array(z.string().uuid()).min(1),
});

// POST /api/conversations/:convId/messages/forward
// Repli REST pour le transfert : copie un message (texte + médias) vers une ou
// plusieurs conversations cibles. La diffusion temps réel est gérée par le WS.
export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const { id: convId } = await ctx.params;
      await assertParticipant(convId, userId);

      const body = forwardSchema.parse(await req.json());
      const { messageId, targetConvIds } = body;

      // Récupère le message source (avec ses médias).
      const original = await prisma.message.findUnique({
        where: { id: messageId },
        include: { media: true },
      });
      if (!original) return fail("Message introuvable", 404, "NOT_FOUND");
      // On ne transfère pas un message déjà supprimé.
      if (original.deletedAt) return fail("Ce message a été supprimé", 410, "GONE");

      const results: Array<{ convId: string; messageId: string }> = [];

      for (const targetConvId of targetConvIds) {
        // Vérifie que l'utilisateur participe à la conversation cible.
        try {
          await assertParticipant(targetConvId, userId);
        } catch {
          continue; // ignore les conversations interdites
        }

        // Copie les médias (nouvelles entrées pointant vers le même binaire B2/local).
        const mediaConnect: { connect: Array<{ id: string }> } = { connect: [] };
        for (const m of original.media) {
          const copy = await prisma.mediaFile.create({
            data: {
              ownerId: userId,
              filename: m.filename,
              mimeType: m.mimeType,
              sizeBytes: m.sizeBytes,
              url: m.url,
              durationMs: m.durationMs,
            },
          });
          mediaConnect.connect.push({ id: copy.id });
        }

        const created = await prisma.message.create({
          data: {
            convId: targetConvId,
            senderId: userId,
            content: original.content,
            type: original.type,
            status: "SENT",
            ...(mediaConnect.connect.length > 0 ? mediaConnect : {}),
          },
        });

        await prisma.conversation.update({
          where: { id: targetConvId },
          data: { updatedAt: new Date() },
        });

        results.push({ convId: targetConvId, messageId: created.id });
      }

      return ok({ forwarded: true, results }, 201);
    } catch (err) {
      return handleError(err);
    }
  },
);
