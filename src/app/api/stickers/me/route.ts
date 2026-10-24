import { fail, handleError, ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurStickers, mesStickers } from "@/lib/stickers-utilisateur";

/**
 * GET /api/stickers/me — les packs du panneau de ce compte, dans son ordre,
 * et ses favoris (identifiants seulement : le client résout le reste par le
 * catalogue, `GET /api/stickers`). Contrat d'Alanya2026 §4.
 */
export const GET = withAuth(async (_req, userId) => {
  try {
    return ok(await mesStickers(userId));
  } catch (e) {
    if (e instanceof ErreurStickers) return fail(e.message, e.statut, e.code);
    return handleError(e);
  }
});
