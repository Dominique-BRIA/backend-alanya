import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { changerBadge } from "@/lib/gestion/verifications";

/** POST /api/admin/users/:id/badge/restore — rend le badge d'une vérification révoquée. */
export const POST = routeAdmin("verifications.decide", async (_req, session, ctx: { params: Promise<{ id: string }> }) => {
  await changerBadge(idUuid((await ctx.params).id, "USER_NOT_FOUND"), true, "", session);
  return okAdmin({ ok: true });
});
