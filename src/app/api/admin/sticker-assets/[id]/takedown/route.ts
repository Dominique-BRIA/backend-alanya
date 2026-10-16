import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { retirerFichier } from "@/lib/gestion/stickers";

/** POST — retire un fichier partout où il sert ; il n'est plus servi (410). */
export const POST = routeAdmin("stickers.moderate", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  await retirerFichier(idNumerique((await ctx.params).id, "STICKER_ASSET_NOT_FOUND"));
  return okAdmin({ ok: true });
});
