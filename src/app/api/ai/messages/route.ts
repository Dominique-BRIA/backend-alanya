import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

interface AiMsg {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

// GET /api/ai/messages — historique de la conversation IA de l'utilisateur (thread unique).
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const thread = await prisma.aiThread.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  const messages = (thread?.messages ?? []) as AiMsg[];
  return ok({
    threadId: thread?.id ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});
