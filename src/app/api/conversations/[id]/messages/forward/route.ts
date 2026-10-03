import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { z } from "zod";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";
import { apercuMessage } from "@/lib/message-payload.mjs";
import { MEDIA_ORDONNE } from "@/lib/media-ordre";
import { refusTransfert } from "@/lib/e2ee-clair.mjs";

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
        // Ordonné : un transfert recopie les médias, et les recopier en
        // désordre propagerait le défaut au message transféré.
        include: { media: MEDIA_ORDONNE },
      });
      /*
       * 🔴 LE MESSAGE DOIT ÊTRE DU FIL DE L'ADRESSE — c'est là seulement que
       * l'appartenance a été vérifiée.
       *
       * 🐛 CE CONTRÔLE MANQUAIT : on vérifiait que l'utilisateur était membre
       * de `:id`, puis on allait chercher le message par son SEUL identifiant,
       * dans n'importe quelle conversation. Il suffisait de connaître l'UUID
       * d'un message — il circule dans les notifications, les réponses citées,
       * les journaux — pour le recopier chez soi et le lire. Prouvé par
       * `scripts/e2ee-clair-banc.mjs` ③. Le WebSocket, lui, faisait ce contrôle.
       *
       * ⚠️ 404 ET NON 403 : répondre « interdit » confirmerait que ce message
       * existe.
       */
      if (!original || original.convId !== convId) {
        return fail("Message introuvable", 404, "NOT_FOUND");
      }
      // On ne transfère pas un message déjà supprimé.
      if (original.deletedAt) return fail("Ce message a été supprimé", 410, "GONE");

      /*
       * 🔴 UN MÉDIA CHIFFRÉ NE SE TRANSFÈRE PAS PAR LE SERVEUR : il n'a pas sa
       * clé. La copie serait un fichier illisible chez le destinataire. C'est
       * l'APPAREIL qui retransmet, clé comprise — même règle que le WebSocket.
       *
       * 🐛 LE WEBSOCKET L'ÉCARTAIT DEPUIS LE LOT A, CETTE ROUTE NON : trouvé en
       * relisant les deux transferts côte à côte (lot D, chapitre 26).
       */
      if (original.media.some((f) => f.chiffre)) {
        return fail("Un média chiffré se transfère depuis l'appareil.", 409, "SOURCE_CHIFFREE");
      }

      // Même règle que le WebSocket, écrite une seule fois : `e2ee-clair.mjs`.
      const etats = await prisma.conversation.findMany({
        where: { id: { in: [convId, ...targetConvIds] } },
        select: { id: true, e2eeActif: true },
      });
      const chiffree = new Map(etats.map((c) => [c.id, c.e2eeActif === true]));
      const refuses: Array<{ convId: string; motif: string }> = [];

      const results: Array<{ convId: string; messageId: string }> = [];

      for (const targetConvId of targetConvIds) {
        // Vérifie que l'utilisateur participe à la conversation cible.
        try {
          await assertParticipant(targetConvId, userId);
        } catch {
          continue; // ignore les conversations interdites
        }

        const motif = refusTransfert({
          sourceChiffree: chiffree.get(convId) === true,
          cibleChiffree: chiffree.get(targetConvId) === true,
          type: original.type,
          contenu: original.content,
          medias: original.media,
        });
        if (motif) {
          refuses.push({ convId: targetConvId, motif });
          continue;
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
            // 🐛 `...mediaConnect` posait `connect` À PLAT dans le message, et
            // Prisma refusait : tout transfert REST d'un média échouait. Les
            // clients passent par le WebSocket, d'où le silence. Trouvé par le
            // témoin ⑤ de `e2ee-clair-banc.mjs` (lot D).
            ...(mediaConnect.connect.length > 0 ? { media: mediaConnect } : {}),
          },
        });

        // Fait remonter la conversation cible + non-lus (vrai nouveau message).
        await prisma.conversation.update({
          where: { id: targetConvId },
          data: {
            updatedAt: new Date(),
            // Un contact ou une position transféré garde son libellé lisible :
            // la charge JSON ne doit jamais atterrir dans la liste des
            // conversations (voir `message-payload.mjs`).
            // ⚠️ `apercuMessage` : un média transféré SANS légende laissait la
            // colonne à NULL, et la liste basculait sur l'aperçu du dernier
            // appel (user, 18/08/2026).
            lastMessage: apercuMessage(original.type, original.content)?.slice(0, 500) ?? null,
            lastMessageAt: new Date(),
            lastMessageSenderID: userId,
            lastMessageType:
              original.type === "TEXT" ? 0
              : original.type === "IMAGE" ? 1
              : original.type === "AUDIO" ? 3
              : original.type === "VIDEO" ? 4
              : 2,
            lastMessageStatus: 0,
          },
        });
        await prisma.participant.updateMany({
          where: { convId: targetConvId, userId: { not: userId } },
          data: { unreadCount: { increment: 1 } },
        });

        results.push({ convId: targetConvId, messageId: created.id });
      }

      /*
       * ⚠️ TOUT REFUSÉ → 409, avec le motif que les clients connaissent : un
       * 201 vide laisserait croire le message parti.
       */
      if (results.length === 0 && refuses.length > 0) {
        return fail(
          "Transfert impossible vers ou depuis une conversation chiffrée.",
          409,
          "CONVERSATION_CHIFFREE",
        );
      }
      return ok({ forwarded: true, results, refuses }, 201);
    } catch (err) {
      return handleError(err);
    }
  },
);
