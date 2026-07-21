import { type NextRequest } from "next/server";
import { ok, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import { revokeRefreshToken } from "@/modules/auth/tokens";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";

// POST /api/auth/logout
// Révoque le refresh token et marque l'utilisateur hors ligne.
export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = refreshSchema.parse(await req.json());

    // F5 : trouve l'utilisateur via le token hash, pour le marquer hors ligne
    const hash = createHash("sha256").update(refreshToken).digest("hex");
    const token = await prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
      select: { userId: true },
    });
    if (token) {
      await prisma.user.update({
        where: { id: token.userId },
        data: { isOnline: 0, lastSeen: new Date() },
      });
    }

    await revokeRefreshToken(refreshToken);
    return ok({ message: "Déconnecté" });
  } catch (err) {
    return handleError(err);
  }
}
