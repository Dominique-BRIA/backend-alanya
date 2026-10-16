import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { supprimerMedia } from "@/lib/gestion/plateforme";

/** DELETE /api/admin/media/:id — fichier effacé du stockage, message vidé s'il n'avait que lui. */
export const DELETE = routeAdmin("media.delete", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  await supprimerMedia(idUuid((await ctx.params).id, "MEDIA_NOT_FOUND"));
  return okAdmin({ ok: true });
});
