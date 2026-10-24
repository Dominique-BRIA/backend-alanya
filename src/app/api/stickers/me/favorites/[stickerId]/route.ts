import { withAuth } from "@/lib/auth-context";
import { ajouterFavori, retirerFavori } from "@/lib/stickers-utilisateur";
import { repondre } from "../../repondre";

/** PUT /api/stickers/me/favorites/:stickerId — l'étoile (idempotent). */
export const PUT = withAuth(async (_req, userId, ctx) => {
  const { stickerId } = await ctx.params;
  return repondre(() => ajouterFavori(userId, stickerId));
});

/** DELETE /api/stickers/me/favorites/:stickerId — retire l'étoile (idempotent). */
export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { stickerId } = await ctx.params;
  return repondre(() => retirerFavori(userId, stickerId));
});
