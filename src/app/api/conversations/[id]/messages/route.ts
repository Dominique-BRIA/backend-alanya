import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { sendMessageSchema } from "@/lib/validation";
import { assertParticipant } from "@/modules/messaging/access";

const PAGE_SIZE = 50;

// GET /api/conversations/:id/messages?cursor=<messageId>&limit=50
// Historique paginé (curseur), du plus récent au plus ancien.
export const GET = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? PAGE_SIZE), 100);

  const messages = await prisma.message.findMany({
    where: { convId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { media: true },
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;

  return ok({
    messages: page.map((m) => ({
      id: m.id,
      convId: m.convId,
      senderId: m.senderId,
      content: m.content,
      type: m.type,
      status: m.status,
      replyToId: m.replyToId,
      media: m.media.map((f) => ({
        id: f.id,
        url: `/api/media/${f.id}`,
        filename: f.filename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        durationMs: f.durationMs,
      })),
      createdAt: m.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  });
});

// POST /api/conversations/:id/messages — envoie un message dans la conversation.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const body = sendMessageSchema.parse(await req.json());

  const message = await prisma.message.create({
    data: {
      convId,
      senderId: userId,
      content: body.content ?? null,
      type: body.type,
      replyToId: body.replyToId,
      status: "SENT",
      ...(body.mediaId ? { media: { connect: { id: body.mediaId } } } : {}),
    },
    include: { media: true },
  });

  // Touche la conversation pour le tri.
  await prisma.conversation.update({ where: { id: convId }, data: { updatedAt: new Date() } });

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
