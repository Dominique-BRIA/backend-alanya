import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

/**
 * GET /api/conversations/:id/pinned — les messages épinglés de la conversation.
 *
 * ⚠️ DEUX FORMES DANS LA MÊME RÉPONSE, et ce n'est pas une négligence.
 *
 * `pinnedMessageId` et `message` décrivent le plus RÉCENT des épinglés, au
 * singulier : c'est ce que lit l'application mobile aujourd'hui. Les retirer
 * ferait disparaître le bandeau épinglé chez tous ceux qui n'ont pas mis à jour
 * — c'est-à-dire tous, le jour du déploiement.
 *
 * `messages` porte la liste complète, du plus récent au plus ancien. Un client
 * qui la connaît l'utilise ; les autres l'ignorent et gardent exactement le
 * comportement d'avant.
 */
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    const epingles = await prisma.messagePinned.findMany({
      where: { convId },
      orderBy: { pinnedAt: "desc" },
      select: {
        messageId: true,
        userId: true,
        pinnedAt: true,
        message: {
          select: { id: true, senderId: true, content: true, type: true, deletedAt: true },
        },
      },
    });

    /*
     * UN MESSAGE SUPPRIMÉ POUR TOUS N'EST PLUS ÉPINGLABLE.
     *
     * La contrainte de clé étrangère efface l'épingle si la LIGNE du message
     * part, mais une suppression « pour tous » ne fait que poser `deletedAt` :
     * le message reste en base. Sans ce filtre, le bandeau afficherait
     * « Message supprimé » — pire qu'un bandeau vide, puisqu'il occupe la place
     * en ne disant rien.
     */
    const vivants = epingles.filter((e) => e.message && !e.message.deletedAt);

    const messages = vivants.map((e) => ({
      id: e.message!.id,
      senderId: e.message!.senderId,
      content: e.message!.content,
      type: e.message!.type,
      pinnedBy: e.userId,
      pinnedAt: e.pinnedAt,
    }));

    return ok({
      // Compatibilité : le plus récent, au singulier.
      pinnedMessageId: messages[0]?.id ?? null,
      message: messages[0]
        ? {
            id: messages[0].id,
            senderId: messages[0].senderId,
            content: messages[0].content,
            type: messages[0].type,
          }
        : null,
      // La liste complète, pour les clients qui savent la lire.
      messages,
    });
  },
);
