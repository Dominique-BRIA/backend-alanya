import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { terminerReunion } from "@/lib/gestion/plateforme";

/** POST /api/admin/meetings/:id/end — comme l'organisateur : durées closes, salle prévenue. */
export const POST = routeAdmin("meetings.end", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new ErreurAdmin(404, "Réunion introuvable", "MEETING_NOT_FOUND");
  await terminerReunion(id);
  return okAdmin({ ok: true });
});
