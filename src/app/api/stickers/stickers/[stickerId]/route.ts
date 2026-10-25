import { withAuth } from "@/lib/auth-context";
import { supprimerCreation } from "@/lib/stickers-perso";
import { repondre } from "../../me/repondre";

/**
 * DELETE /api/stickers/stickers/:id — retire une de MES créations (idempotent).
 * Son image reste servie : les messages déjà envoyés la montrent encore.
 */
export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { stickerId } = await ctx.params;
  return repondre(() => supprimerCreation(userId, stickerId));
});
