import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createConversationSchema } from "@/lib/validation";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";

// GET /api/conversations — liste les conversations de l'utilisateur, triées par activité,
// avec le dernier message et le nombre de non-lus.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const parts = await prisma.participant.findMany({
    where: { userId },
    include: {
      conv: {
        include: {
          participants: { include: { user: { include: { profile: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });

  // Trie par date du dernier message (ou de création).
  parts.sort((a, b) => {
    const da = a.conv.messages[0]?.createdAt ?? a.conv.createdAt;
    const db = b.conv.messages[0]?.createdAt ?? b.conv.createdAt;
    return db.getTime() - da.getTime();
  });

  const conversations = await Promise.all(
    parts.map(async (p) => {
      const conv = p.conv;
      const last = conv.messages[0] ?? null;
      const unread = await prisma.message.count({
        where: {
          convId: conv.id,
          senderId: { not: userId },
          createdAt: p.lastReadAt ? { gt: p.lastReadAt } : undefined,
        },
      });

      // Pour une conversation directe, le titre = l'autre participant.
      const others = conv.participants.filter((pp) => pp.userId !== userId);
      const title = conv.isGroup
        ? conv.name
        : (others[0]?.user.profile?.displayName ?? others[0]?.user.publicNumber ?? "Inconnu");

      return {
        id: conv.id,
        isGroup: conv.isGroup,
        title,
        avatarUrl: conv.isGroup ? conv.avatarUrl : others[0]?.user.profile?.avatarUrl ?? null,
        members: conv.participants.map((pp) => ({
          id: pp.userId,
          pseudo: pp.user.profile?.displayName ?? null,
          publicNumber: pp.user.publicNumber,
        })),
        lastMessage: last
          ? { id: last.id, content: last.content, type: last.type, senderId: last.senderId, createdAt: last.createdAt }
          : null,
        unread,
        updatedAt: last?.createdAt ?? conv.createdAt,
      };
    }),
  );

  return ok({ conversations });
});

// POST /api/conversations — crée (ou récupère) une conversation directe ou un groupe.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = createConversationSchema.parse(await req.json());

  // --- Conversation directe ---
  if (body.publicNumber) {
    const target = await prisma.user.findUnique({ where: { publicNumber: body.publicNumber } });
    if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
    if (target.id === userId) return fail("Conversation avec soi-même impossible", 400, "SELF");

    const conv = await findOrCreateDirectConversation(userId, target.id);
    return ok({ id: conv.id, isGroup: false }, 201);
  }

  // --- Conversation de groupe ---
  const members = await prisma.user.findMany({
    where: { publicNumber: { in: body.memberNumbers! } },
    select: { id: true },
  });
  const memberIds = new Set(members.map((m) => m.id));
  memberIds.add(userId); // l'auteur est membre

  const conv = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: body.name!,
      participants: {
        create: Array.from(memberIds).map((id) => ({
          userId: id,
          role: id === userId ? "ADMIN" : "MEMBER",
        })),
      },
    },
  });
  return ok({ id: conv.id, isGroup: true }, 201);
});
