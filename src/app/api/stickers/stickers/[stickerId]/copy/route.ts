import { fail, handleError, ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurStickers } from "@/lib/stickers-utilisateur";
import { copierSticker } from "@/lib/stickers-perso";

/**
 * POST /api/stickers/stickers/:id/copy — garde dans « Mes créations » un
 * sticker reçu (celui d'un autre, qu'on ne peut pas renvoyer tel quel).
 * Idempotent : la même image n'entre qu'une fois. → `{ stickerId, assetId, packId, reutilise }`.
 */
export const POST = withAuth(async (_req, userId, ctx) => {
  try {
    const { stickerId } = await ctx.params;
    return ok(await copierSticker(userId, stickerId), 201);
  } catch (e) {
    if (e instanceof ErreurStickers) return fail(e.message, e.statut, e.code);
    return handleError(e);
  }
});
