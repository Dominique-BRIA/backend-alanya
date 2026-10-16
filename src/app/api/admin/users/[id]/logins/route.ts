import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { connexionsCompte } from "@/lib/gestion/comptes";

/** GET /api/admin/users/:id/logins — les 100 dernières connexions (`userAccess`). */
export const GET = routeAdmin("users.read", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  return okAdmin(await connexionsCompte(idUuid((await ctx.params).id, "USER_NOT_FOUND")));
});
