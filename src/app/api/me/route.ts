import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { requireUser, UnauthorizedError } from "@/lib/auth-context";

// GET /api/me — profil de l'utilisateur authentifié (test de l'access token).
export async function GET(req: NextRequest) {
  try {
    const { sub } = requireUser(req);
    const user = await prisma.user.findUnique({
      where: { id: sub },
      include: { profile: true },
    });
    if (!user) return fail("Utilisateur introuvable", 404);
    return ok({
      id: user.id,
      email: user.email,
      publicNumber: user.publicNumber,
      pseudo: user.profile?.displayName ?? null,
      avatarUrl: user.profile?.avatarUrl ?? null,
      statusMsg: user.profile?.statusMsg ?? null,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
    return handleError(err);
  }
}
