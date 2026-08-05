import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { sendMessageSchema } from "@/lib/validation";
import { assertParticipant } from "@/modules/messaging/access";

const PAGE_SIZE = 50;

// GET /api/conversations/:id/messages?cursor=<messageId>&limit=50
// Historique paginé (curseur), du plus récent au plus ancien.
export const GET = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  // F10 : remet le compteur de non-lus à 0 quand l'utilisateur ouvre la conversation
  await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { unreadCount: 0 },
  });

  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? PAGE_SIZE), 100);

  // Réglage « messages éphémères » de la conversation (exposé à l'app).
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });

  // Blocage : masque à la lecture les messages des utilisateurs avec qui je suis
  // bloqué (dans un sens ou l'autre) → le blocage est silencieux et effectif.
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
      // On GARDE les messages supprimés (deletedAt != null) pour afficher le
    // placeholder « Ce message a été supprimé ». On EXCLUT seulement les
    // messages que CET utilisateur a masqués (« supprimer pour moi »).
      hides: { none: { userId } },
      // Messages éphémères arrivés à expiration : masqués à la lecture (la purge
      // définitive est faite périodiquement par le serveur WS).
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(blockedIds.length > 0 ? { senderId: { notIn: blockedIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      media: true,
      reactions: { select: { userId: true, emoji: true } },
      stars: { where: { userId }, select: { id: true } },
    },
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;

  // --- Snapshots des messages cités (replyTo) ---
  // On récupère en une seule requête tous les messages référencés par replyToId,
  // pour pouvoir afficher l'aperçu côté UI même si le message original n'est pas
  // chargé en mémoire locale.
  const replyIds = [...new Set(
    page.map((m) => m.replyToId).filter(Boolean) as string[],
  )];
  const replyTargets = replyIds.length > 0
    ? await prisma.message.findMany({
        where: { id: { in: replyIds } },
        select: { id: true, senderId: true, content: true, type: true, deletedAt: true },
      })
    : [];
  const replyMap = new Map(replyTargets.map((t) => [t.id, t]));

  return ok({
    messages: page.map((m) => {
      let replyTo = null;
      if (m.replyToId && replyMap.has(m.replyToId)) {
        const t = replyMap.get(m.replyToId)!;
        replyTo = {
          id: m.replyToId,
          senderId: t.senderId,
          type: t.type,
          content: t.deletedAt ? null : t.content,
          isDeleted: t.deletedAt !== null,
        };
      }
      return {
        id: m.id,
        convId: m.convId,
        senderId: m.senderId,
        content: m.content,
        type: m.type,
        status: m.status,
        replyToId: m.replyToId,
        replyTo,
        deletedAt: m.deletedAt,
        editedAt: m.editedAt,
        expiresAt: m.expiresAt,
        starred: m.stars.length > 0,
        reactions: m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
        media: m.media.map((f) => ({
          id: f.id,
          url: `/api/media/${f.id}`,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          durationMs: f.durationMs,
        })),
        createdAt: m.createdAt,
      };
    }),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    disappearingSeconds: convCfg?.disappearingSeconds ?? 0,
  });
});

// POST /api/conversations/:id/messages — envoie un message dans la conversation.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const body = sendMessageSchema.parse(await req.json());

  /**
   * Blocage : on refuse ici aussi.
   *
   * Le client bascule sur cette route quand le WebSocket n'acquitte pas — ce
   * qui est précisément ce qui se passe entre deux personnes bloquées. Sans ce
   * contrôle, le repli serait une porte dérobée : le message passerait par HTTP
   * ce que le temps réel venait de refuser.
   *
   * On répond 403 et non 200 : mentir à l'appelant n'est pas le rôle de l'API.
   * C'est le client qui, connaissant le blocage, n'envoie rien et laisse le
   * message en « en cours d'envoi » — l'indicateur qui ne se résout jamais.
   */
  const participants = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  if (participants.length === 2) {
    const autre = participants.find((p) => p.userId !== userId)?.userId;
    if (autre) {
      const blocage = await prisma.blocked.findFirst({
        where: {
          OR: [
            { alanyaID: userId, idCallerBlock: autre },
            { alanyaID: autre, idCallerBlock: userId },
          ],
        },
        select: { idBlock: true },
      });
      if (blocage) return fail("Message non distribuable", 403, "BLOCKED");
    }
  }

  // Messages éphémères : calcule l'expiration selon le réglage de la conversation.
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });
  const ttl = convCfg?.disappearingSeconds ?? 0;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  const message = await prisma.message.create({
    data: {
      convId,
      senderId: userId,
      content: body.content ?? null,
      type: body.type,
      replyToId: body.replyToId,
      status: "SENT",
      expiresAt,
      ...(body.mediaId ? { media: { connect: { id: body.mediaId } } } : {}),
    },
    include: { media: true },
  });

  // F10 + F11 : met à jour le dernier message + incrémente unreadCount
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: (body.content ?? "").slice(0, 500) || null,
      lastMessageAt: new Date(),
      lastMessageSenderID: userId,
      lastMessageType: body.type === "TEXT" ? 0 : body.type === "IMAGE" ? 1 : body.type === "AUDIO" ? 3 : body.type === "VIDEO" ? 4 : 2,
      lastMessageStatus: 0,
    },
  });
  await prisma.participant.updateMany({
    where: { convId, userId: { not: userId } },
    data: { unreadCount: { increment: 1 } },
  });

  return ok(
    {
      id: message.id,
      convId: message.convId,
      senderId: message.senderId,
      content: message.content,
      type: message.type,
      status: message.status,
      replyToId: message.replyToId,
      media: message.media.map((f) => ({
        id: f.id,
        url: `/api/media/${f.id}`,
        filename: f.filename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        durationMs: f.durationMs,
      })),
      createdAt: message.createdAt,
    },
    201,
  );
});
