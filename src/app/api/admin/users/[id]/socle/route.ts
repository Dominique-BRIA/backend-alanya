import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { changerSocle } from "@/lib/gestion/comptes";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/admin/users/:id/socle — `{ accountType: 0 | 1 | 2 }`, le genre public du compte. */
export const PUT = routeAdmin("users.socle", async (req, _session, ctx: Ctx) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  return okAdmin(await changerSocle(id, await req.json().catch(() => null)));
});
