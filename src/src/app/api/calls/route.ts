import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createCallSchema } from "@/lib/validation";
import { assertParticipant } from "@/modules/messaging/access";
import { conversationMeta } from "@/lib/calls";

// GET /api/calls — historique des appels de l'utilisateur (50 derniers).
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const parts = await prisma.callParticipant.findMany({
    where: { userId },
    orderBy: { call: { startedAt: "desc" } },
    take: 50,
    include: {
      call: {
        include: {
          initiator: true,
          participants: { include: { user: true } },
        },
      },
    },
  });

  const convIds = [...new Set(parts.map((p) => p.call.convId).filter(Boolean))] as string[];
  const convs = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, isGroup: true, name: true },
  });
  const convMap = new Map(convs.map((c) => [c.id, c]));

  const calls = parts.map((p) => {
    const c = p.call;
    const others = c.participants.filter((pp) => pp.userId !== userId);
    const conv = c.convId ? convMap.get(c.convId) : null;
    const isGroup = conv?.isGroup ?? false;
    const peer = others[0]?.user;
    const peerName = isGroup
      ? (conv?.name ?? "Groupe")
      : (peer?.pseudo ?? peer?.publicNumber ?? "Inconnu");
    return {
      id: c.id,
      convId: c.convId,
      type: c.type,
      status: c.status,
      isOutgoing: c.initiatorId === userId,
      isGroup,
      peerName,
      peerNumber: isGroup ? null : (peer?.publicNumber ?? null),
      peerAvatarUrl: isGroup ? null : (peer?.avatarUrl ?? null),
      participantCount: c.participants.length,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      durationSec:
        c.answeredAt && c.endedAt
          ? Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000)
          : null,
    };
  });

  // Déduplique (un appel = une entrée par participant).
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return ok({ calls: unique });
});

// POST /api/calls — démarre un appel (statut RINGING) dans une conversation.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const { convId, type } = createCallSchema.parse(await req.json());
  await assertParticipant(convId, userId);

  // AUTO-CLEANUP : termine les anciens appels restés bloqués (RINGING > 2min ou ONGOING > 2h)
  // pour cet utilisateur. Évite l'erreur 409 BUSY après un crash de l'app.
  const staleThreshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes pour RINGING
  const staleCalls = await prisma.callParticipant.findMany({
    where: {
      userId,
      leftAt: null,
      call: {
        status: "RINGING",
        startedAt: { lt: staleThreshold },
      },
    },
    select: { callId: true },
  });
  if (staleCalls.length > 0) {
    await prisma.call.updateMany({
      where: { id: { in: staleCalls.map((s) => s.callId) } },
      data: { status: "ENDED", endedAt: new Date() },
    });
    await prisma.callParticipant.updateMany({
      where: { callId: { in: staleCalls.map((s) => s.callId) } },
      data: { leftAt: new Date() },
    });
  }

  const busy = await prisma.callParticipant.findFirst({
    where: {
      userId,
      joinedAt: { not: null },
      leftAt: null,
      call: { status: { in: ["RINGING", "ONGOING"] } },
    },
  });
  if (busy) return fail("Vous êtes déjà en appel", 409, "BUSY");

  const convParts = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  const memberIds = convParts.map((p) => p.userId);

  const call = await prisma.call.create({
    data: {
      initiatorId: userId,
      convId,
      type,
      status: "RINGING",
      participants: {
        create: memberIds.map((id) => ({
          userId: id,
          joinedAt: id === userId ? new Date() : null,
        })),
      },
    },
    include: {
      initiator: true,
      participants: { include: { user: true } },
    },
  });

  const callees = call.participants
    .filter((p) => p.userId !== userId)
    .map((p) => ({
      userId: p.userId,
      pseudo: p.user.pseudo ?? null,
      publicNumber: p.user.publicNumber,
    }));

  const meta = await conversationMeta(call.convId);

  return ok(
    {
      id: call.id,
      convId: call.convId,
      type: call.type,
      status: call.status,
      isGroup: meta.isGroup,
      groupName: meta.groupName,
      memberCount: meta.memberCount,
      callees,
      callerName: call.initiator.pseudo ?? call.initiator.publicNumber,
    },
    201,
  );
});
