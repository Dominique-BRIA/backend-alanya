import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

/**
 * POST /api/conversations/:id/pin-message — épingle ou détache un message.
 *
 * Corps : `{ messageId: string, epingle?: boolean }`.
 *
 * ⚠️ COMPATIBILITÉ AVEC L'ANCIEN CONTRAT, qui n'avait qu'un épinglé par
 * conversation : `{ messageId: null }` détachait alors le message courant. Cette
 * forme continue de fonctionner — elle détache TOUT, ce qui est le sens le plus
 * proche de ce qu'elle voulait dire. L'application mobile l'envoie encore.
 *
 * Sans `epingle`, on BASCULE : épingler un message déjà épinglé le détache.
 * C'est ce que fait le menu du client, et cela évite un aller-retour pour savoir
 * dans quel état on se trouve.
 */
export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    let corps: { messageId?: unknown; epingle?: unknown };
    try {
      corps = await req.json();
    } catch {
      return fail("Corps JSON invalide", 400, "BAD_JSON");
    }

    const messageId = typeof corps.messageId === "string" ? corps.messageId : null;

    // Ancien contrat : `null` détachait. Il détache maintenant tout.
    if (!messageId) {
      await prisma.messagePinned.deleteMany({ where: { convId } });
      await prisma.conversation.update({
        where: { id: convId },
        data: { pinnedMessageId: null },
      });
      return ok({ pinnedMessageId: null, messages: [] });
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId, convId },
      select: { id: true, deletedAt: true },
    });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");
    if (message.deletedAt) {
      return fail("Ce message a été supprimé", 400, "MESSAGE_DELETED");
    }

    const existant = await prisma.messagePinned.findUnique({
      where: { convId_messageId: { convId, messageId } },
      select: { id: true },
    });

    const doitEpingler = typeof corps.epingle === "boolean" ? corps.epingle : existant === null;

    if (doitEpingler) {
      // `upsert` et non `create` : deux appareils du même compte peuvent
      // épingler en même temps, et la contrainte d'unicité ferait échouer le
      // second sur une action pourtant sans conséquence.
      await prisma.messagePinned.upsert({
        where: { convId_messageId: { convId, messageId } },
        create: { convId, messageId, userId },
        update: {},
      });
    } else {
      await prisma.messagePinned.deleteMany({ where: { convId, messageId } });
    }

    /*
     * LA COLONNE D'ORIGINE SUIT LE PLUS RÉCENT.
     *
     * L'application mobile ne lit qu'elle. La laisser figée montrerait chez elle
     * un épinglé détaché depuis longtemps, ou masquerait le dernier posé.
     */
    const dernier = await prisma.messagePinned.findFirst({
      where: { convId },
      orderBy: { pinnedAt: "desc" },
      select: { messageId: true },
    });
    await prisma.conversation.update({
      where: { id: convId },
      data: { pinnedMessageId: dernier?.messageId ?? null },
    });

    const tous = await prisma.messagePinned.findMany({
      where: { convId },
      orderBy: { pinnedAt: "desc" },
      select: { messageId: true },
    });

    return ok({
      pinnedMessageId: dernier?.messageId ?? null,
      messages: tous.map((e) => e.messageId),
    });
  },
);
