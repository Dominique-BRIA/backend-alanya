import { prisma } from "@/lib/prisma";

export async function conversationMeta(convId: string | null) {
  if (!convId) return { isGroup: false, groupName: null as string | null, memberCount: 2 };
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  return {
    isGroup: conv?.isGroup ?? false,
    groupName: conv?.name ?? null,
    memberCount: conv?.participants.length ?? 2,
  };
}

export async function activeCallParticipants(callId: string) {
  const parts = await prisma.callParticipant.findMany({
    where: { callId, joinedAt: { not: null }, leftAt: null },
    include: { user: { include: { profile: true } } },
  });
  return parts.map((p) => ({
    userId: p.userId,
    displayName: p.user.profile?.displayName ?? p.user.publicNumber,
  }));
}
