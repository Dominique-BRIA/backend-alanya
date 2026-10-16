import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { supprimerReunion } from "@/lib/gestion/plateforme";

/** DELETE /api/admin/meetings/:id — terminée d'abord si elle tourne encore, puis supprimée. */
export const DELETE = routeAdmin("meetings.delete", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new ErreurAdmin(404, "Réunion introuvable", "MEETING_NOT_FOUND");
  await supprimerReunion(id);
  return okAdmin({ ok: true });
});
