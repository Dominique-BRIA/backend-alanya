import { fail, handleError, ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurStickers } from "@/lib/stickers-utilisateur";
import { creerSticker } from "@/lib/stickers-perso";

/**
 * POST /api/stickers/assets — crée un sticker à partir de MON image (25/10/2026,
 * « comme WhatsApp »). Multipart : `file` (PNG ou WebP, 1 Mo et 1024 px au
 * plus), `emoji` facultatif. Il entre en tête de « Mes créations ».
 * → 201 `{ stickerId, assetId, packId, reutilise }`. Contrat d'Alanya2026 V1b.
 */
export const POST = withAuth(async (req, userId) => {
  try {
    return ok(await creerSticker(userId, await req.formData().catch(() => null)), 201);
  } catch (e) {
    if (e instanceof ErreurStickers) return fail(e.message, e.statut, e.code);
    return handleError(e);
  }
});
