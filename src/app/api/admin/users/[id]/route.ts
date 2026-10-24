import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { compteRequis, presenterCompteDetail, supprimer } from "@/lib/gestion/comptes";

type Ctx = { params: Promise<{ id: string }> };

export const GET = routeAdmin("users.read", async (_req, _s, ctx: Ctx) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  return okAdmin(presenterCompteDetail(await compteRequis(id)));
});

/** DELETE /api/admin/users/:id — effacement logique, sessions coupées. */
export const DELETE = routeAdmin("users.delete", async (_req, session, ctx: Ctx) => {
  await supprimer(idUuid((await ctx.params).id, "USER_NOT_FOUND"), session);
  return okAdmin({ ok: true });
});
