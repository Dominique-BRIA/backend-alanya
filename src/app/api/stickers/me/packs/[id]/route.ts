import { withAuth } from "@/lib/auth-context";
import { installerPack, retirerPack } from "@/lib/stickers-utilisateur";
import { repondre } from "../../repondre";

/** PUT /api/stickers/me/packs/:id — ajoute un pack au panneau (idempotent). */
export const PUT = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  return repondre(() => installerPack(userId, id));
});

/** DELETE /api/stickers/me/packs/:id — le retire du panneau (idempotent). */
export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  return repondre(() => retirerPack(userId, id));
});
