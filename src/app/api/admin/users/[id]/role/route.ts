import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { changerRole } from "@/lib/gestion/comptes";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/admin/users/:id/role — `{ type_compte: 0 | 1 | 2 }`, le rôle d'administration. */
export const PUT = routeAdmin("users.role", async (req, session, ctx: Ctx) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  const corps = (await req.json().catch(() => ({}))) as { type_compte?: unknown };
  return okAdmin(await changerRole(id, corps?.type_compte, session));
});
