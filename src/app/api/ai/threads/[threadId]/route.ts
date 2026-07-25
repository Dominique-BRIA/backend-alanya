import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// DELETE /api/ai/threads/:threadId — supprime une conversation IA.
export const DELETE = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { threadId } = await ctx.params;
    const thread = await prisma.aiThread.findFirst({
      where: { id: threadId, userId },
      select: { id: true },
    });
    if (!thread) return fail("Conversation introuvable", 404, "NOT_FOUND");
    await prisma.aiThread.delete({ where: { id: threadId } });
    return ok({ deleted: true, threadId });
  },
);
