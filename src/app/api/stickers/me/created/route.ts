import { fail, handleError, ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurStickers } from "@/lib/stickers-utilisateur";
import { creationOuverte, mesCreations } from "@/lib/stickers-perso";

/** GET /api/stickers/me/created — « Mes créations » (aussi rendues par `GET /api/stickers/me`). */
export const GET = withAuth(async (_req, userId) => {
  try {
    if (!(await creationOuverte())) return fail("Introuvable", 404, "NOT_FOUND");
    return ok((await mesCreations(userId)) ?? { stickers: [] });
  } catch (e) {
    if (e instanceof ErreurStickers) return fail(e.message, e.statut, e.code);
    return handleError(e);
  }
});
