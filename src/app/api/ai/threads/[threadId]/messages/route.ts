import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/ai/threads/:threadId/messages — messages d'une conversation IA.
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { threadId } = await ctx.params;
    const thread = await prisma.aiThread.findFirst({
      where: { id: threadId, userId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!thread) return fail("Conversation introuvable", 404, "NOT_FOUND");
    return ok({
      threadId: thread.id,
      title: thread.title ?? "Conversation",
      messages: thread.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  },
);
