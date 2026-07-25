import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";

const MAX_RESULTS = 60;

// GET /api/conversations/:id/messages/search?q=... — recherche texte dans TOUT
// l'historique de la conversation (pas seulement les messages chargés côté app).
// Exclut : messages supprimés, masqués pour moi, et des utilisateurs bloqués.
export const GET = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;
    await assertParticipant(convId, userId);

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length === 0) return ok({ query: q, results: [] });

    // Même filtre de blocage que getMessages (cohérence lecture).
    const blockedRows = await prisma.blocked.findMany({
      where: { OR: [{ alanyaID: userId }, { idCallerBlock: userId }] },
      select: { alanyaID: true, idCallerBlock: true },
    });
    const blockedIds = [
      ...new Set(
        blockedRows.map((b) => (b.alanyaID === userId ? b.idCallerBlock : b.alanyaID)),
      ),
    ];

    const messages = await prisma.message.findMany({
      where: {
        convId,
        deletedAt: null,
        content: { contains: q, mode: "insensitive" },
        hides: { none: { userId } },
        ...(blockedIds.length > 0 ? { senderId: { notIn: blockedIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: MAX_RESULTS,
      select: { id: true, senderId: true, content: true, createdAt: true },
    });

    return ok({
      query: q,
      results: messages.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  },
);
