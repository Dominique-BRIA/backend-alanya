import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { aiChatSchema } from "@/lib/validation";
import { generateReply, type GeminiTurn } from "@/lib/gemini";

interface AiMsg {
  role: string;
  content: string;
}

// POST /api/ai/chat — envoie un message à l'assistant et renvoie sa réponse.
// Multi-conversations : `threadId` optionnel. Absent → nouvelle conversation
// (titrée d'après le 1er message). Présent → poursuit cette conversation.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = await req.json();
  const { message } = aiChatSchema.parse(body);
  const threadId = typeof body?.threadId === "string" ? body.threadId : null;

  let thread: { id: string; messages?: AiMsg[] };
  if (threadId) {
    const found = await prisma.aiThread.findFirst({
      where: { id: threadId, userId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!found) return fail("Conversation introuvable", 404, "NOT_FOUND");
    thread = found;
  } else {
    const title = message.trim().slice(0, 40) || "Nouvelle conversation";
    thread = await prisma.aiThread.create({ data: { userId, title } });
  }
  const previousMessages = (thread.messages ?? []) as AiMsg[];

  // Enregistre le message utilisateur.
  await prisma.aiMessage.create({
    data: { threadId: thread.id, role: "USER", content: message },
  });

  // Construit l'historique (limité aux 20 derniers tours pour le contexte).
  const previous = previousMessages.slice(-20);
  const history: GeminiTurn[] = [
    ...previous.map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("model" as const),
      text: m.content,
    })),
    { role: "user", text: message },
  ];

  // Appelle Gemini (ou repli démo).
  let reply: string;
  try {
    reply = await generateReply(history);
  } catch (e) {
    reply = `⚠️ L'assistant est momentanément indisponible. (${(e as Error).message})`;
  }

  const saved = await prisma.aiMessage.create({
    data: { threadId: thread.id, role: "MODEL", content: reply },
  });
  await prisma.aiThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });

  return ok({
    threadId: thread.id,
    reply: { id: saved.id, role: "MODEL", content: reply, createdAt: saved.createdAt },
  });
});
