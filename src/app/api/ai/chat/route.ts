import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { aiChatSchema } from "@/lib/validation";
import {
  generateReply,
  MESSAGE_INDISPONIBLE,
  type TourAssistant,
} from "@/lib/assistant";

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
  const history: TourAssistant[] = [
    ...previous.map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("model" as const),
      text: m.content,
    })),
    { role: "user", text: message },
  ];

  /*
   * 🔴 L'ÉCHEC NE DIT RIEN DE PLUS QUE « JE NE PEUX PAS RÉPONDRE ».
   *
   * Cette ligne recopiait le message de l'exception dans la bulle — et ce
   * message portait la réponse brute du fournisseur. Le 25/08/2026, un refus a
   * ainsi affiché à l'utilisateur le nom du service, son code d'erreur et son
   * motif, puis l'a ENREGISTRÉ EN BASE : la fuite restait dans la conversation
   * après le rétablissement.
   *
   * Le détail est déjà journalisé par `generateReply`, avec plus de contexte que
   * ce qu'une exception peut porter. Rien à en tirer de plus ici.
   */
  let reply: string;
  try {
    reply = await generateReply(history);
  } catch {
    reply = MESSAGE_INDISPONIBLE;
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
