import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createConversationSchema } from "@/lib/validation";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";

// Convertit le type entier (BD) en string (API)
function _typeToString(t: number | null): string {
  switch (t) {
    case 0: return "TEXT";
    case 1: return "IMAGE";
    case 2: return "FILE";
    case 3: return "AUDIO";
    case 4: return "VIDEO";
    default: return "TEXT";
  }
}

// GET /api/conversations — liste les conversations de l'utilisateur.
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const showArchived = req.nextUrl.searchParams.get("archived") === "true";

  const parts = await prisma.participant.findMany({
    where: {
      userId,
      ...(showArchived ? {} : { isArchived: 0 }),
    },
    include: {
      conv: {
        include: {
          participants: { include: { user: true } },
          // Fallback : charge le dernier message si lastMessage est NULL
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });

  // Trie : épinglés d'abord, puis par date du dernier message
  parts.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned;
    const da = a.conv.lastMessageAt ?? a.conv.messages[0]?.createdAt ?? a.conv.createdAt;
    const db = b.conv.lastMessageAt ?? b.conv.messages[0]?.createdAt ?? b.conv.createdAt;
    return db.getTime() - da.getTime();
  });

  const conversations = parts.map((p) => {
    const conv = p.conv;
    const others = conv.participants.filter((pp) => pp.userId !== userId);
    const title = conv.isGroup
      ? conv.name
      : (others[0]?.user.pseudo ?? others[0]?.user.publicNumber ?? "Inconnu");

    // F11 : dernier message — utilise le champ dénormalisé OU le fallback
    const fallbackLast = conv.messages[0];
    const lastContent = conv.lastMessage ?? fallbackLast?.content ?? null;
    const lastType = conv.lastMessageType != null
        ? _typeToString(conv.lastMessageType)
        : (fallbackLast?.type ?? null);
    const lastSenderId = conv.lastMessageSenderID ?? fallbackLast?.senderId ?? null;
    const lastCreatedAt = conv.lastMessageAt ?? fallbackLast?.createdAt ?? null;

    return {
      id: conv.id,
      isGroup: conv.isGroup,
      title,
      avatarUrl: conv.isGroup ? conv.avatarUrl : others[0]?.user.avatarUrl ?? null,
      members: conv.participants.map((pp) => ({
        id: pp.userId,
        pseudo: pp.user.pseudo ?? null,
        publicNumber: pp.user.publicNumber,
        role: pp.role,
        isOnline: pp.user.isOnline,
        lastSeen: pp.user.lastSeen ?? null,
      })),
      lastMessage: lastContent != null
          ? {
              id: fallbackLast?.id ?? "",
              content: lastContent,
              type: lastType ?? "TEXT",
              senderId: lastSenderId ?? "",
              createdAt: lastCreatedAt ?? conv.createdAt,
            }
          : null,
      unread: p.unreadCount,
      isPinned: p.isPinned === 1,
      isArchived: p.isArchived === 1,
      updatedAt: lastCreatedAt ?? conv.createdAt,
    };
  });

  return ok({ conversations });
});

// POST /api/conversations — crée (ou récupère) une conversation.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = createConversationSchema.parse(await req.json());

  if (body.publicNumber) {
    const target = await prisma.user.findUnique({ where: { publicNumber: body.publicNumber } });
    if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
    if (target.id === userId) return fail("Conversation avec soi-même impossible", 400, "SELF");

    const conv = await findOrCreateDirectConversation(userId, target.id);
    return ok({ id: conv.id, isGroup: false }, 201);
  }

  const members = await prisma.user.findMany({
    where: { publicNumber: { in: body.memberNumbers! } },
    select: { id: true },
  });
  const memberIds = new Set(members.map((m) => m.id));
  memberIds.add(userId);

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
