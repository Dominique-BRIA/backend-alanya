import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/starred — messages favoris de l'utilisateur, toutes conversations
// confondues (du plus récent au plus ancien). Exclut les messages supprimés.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const stars = await prisma.messageStar.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      message: {
        include: {
          conv: { select: { id: true, name: true, isGroup: true } },
          sender: { select: { id: true, pseudo: true, publicNumber: true } },
        },
      },
    },
  });

  const starred = stars
    .filter((s) => !s.message.deletedAt)
    .map((s) => {
      const m = s.message;
      const senderName = m.sender.pseudo ?? m.sender.publicNumber;
      return {
        id: m.id,
        convId: m.convId,
        isGroup: m.conv.isGroup,
        convName: m.conv.isGroup ? (m.conv.name ?? "Groupe") : senderName,
        senderId: m.senderId,
        senderName,
        content: m.content,
        type: m.type,
        createdAt: m.createdAt,
      };
    });

  return ok({ starred });
});
