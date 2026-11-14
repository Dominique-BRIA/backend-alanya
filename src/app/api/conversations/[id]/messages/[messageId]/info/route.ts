import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// GET /api/conversations/:id/messages/:messageId/info — accusés « lu » par membre.
// Dérivé de Participant.lastReadAt (lu si lastReadAt >= date du message).
// Réservé à l'expéditeur du message (comme WhatsApp).
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const message = await prisma.message.findFirst({
      where: { id: messageId, convId },
      select: { id: true, senderId: true, createdAt: true },
    });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");
    if (message.senderId !== userId) {
      return fail("Infos réservées à vos propres messages", 403, "FORBIDDEN");
    }

    const participants = await prisma.participant.findMany({
      where: { convId, userId: { not: userId }, ...MEMBRE_ACTIF },
      select: {
        userId: true,
        lastReadAt: true,
        user: {
          select: {
            nom: true,
            pseudo: true,
            publicNumber: true,
            avatarUrl: true,
            isOnline: true,
            lastSeen: true,
            lastSeenVisibility: true,
          },
        },
      },
    });

    const members = participants.map((p) => {
      const read = p.lastReadAt != null && p.lastReadAt >= message.createdAt;
      /*
       * « REÇU » (14/11/2026) — le troisième état de l'écran « Infos du
       * message », comme l'application de référence : lu, reçu, pas encore reçu.
       *
       * Le serveur ne retient pas la livraison membre par membre (le statut
       * DELIVERED est global au message). On la DÉDUIT : un membre connecté
       * depuis l'envoi a reçu le message, par la trame en direct ou par la
       * relève à la reconnexion. Lu implique reçu.
       *
       * ⚠️ CONFIDENTIALITÉ : un membre qui cache sa présence (« personne »)
       * ne la laisse pas deviner par ce biais. Pour lui, reçu = lu.
       */
      const presenceVisible = p.user.lastSeenVisibility !== 0;
      const connecteDepuis =
        p.user.isOnline === 1 ||
        (p.user.lastSeen != null && p.user.lastSeen >= message.createdAt);
      const received = read || (presenceVisible && connecteDepuis);
      return {
        userId: p.userId,
        name: nomAffichage(p.user),
        avatarUrl: avatarPublicUrl(p.user.avatarUrl ?? null),
        read,
        readAt: read ? p.lastReadAt : null,
        received,
      };
    });

    return ok({ messageId: message.id, createdAt: message.createdAt, members });
  },
);
