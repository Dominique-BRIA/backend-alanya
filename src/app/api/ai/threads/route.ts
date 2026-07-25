import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/ai/threads — liste des conversations IA de l'utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const threads = await prisma.aiThread.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return ok({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title ?? "Conversation",
      updatedAt: t.updatedAt,
      lastMessage: t.messages[0]?.content ?? null,
    })),
  });
});
