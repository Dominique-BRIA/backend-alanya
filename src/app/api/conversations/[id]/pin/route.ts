import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// PATCH /api/conversations/:id/pin — épingler/désépingler une conversation.
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const { pinned } = await req.json(); // true ou false

  const participant = await prisma.participant.findUnique({
    where: { convId_userId: { convId, userId } },
  });
  if (!participant) return fail("Conversation introuvable", 404, "NOT_FOUND");

  await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { isPinned: pinned ? 1 : 0 },
  });

  return ok({ convId, isPinned: pinned ? 1 : 0 });
});
