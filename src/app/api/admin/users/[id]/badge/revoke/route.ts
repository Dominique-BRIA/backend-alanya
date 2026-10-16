import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { changerBadge } from "@/lib/gestion/verifications";

/** POST /api/admin/users/:id/badge/revoke — `{ reason }` : le badge tombe. */
export const POST = routeAdmin("verifications.decide", async (req, session, ctx: { params: Promise<{ id: string }> }) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  const corps = (await req.json().catch(() => ({}))) as { reason?: unknown };
  await changerBadge(id, false, typeof corps?.reason === "string" ? corps.reason.trim() : "", session);
  return okAdmin({ ok: true });
});
