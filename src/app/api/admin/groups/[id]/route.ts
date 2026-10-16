import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { detailGroupe, supprimerGroupe } from "@/lib/gestion/plateforme";

type Ctx = { params: Promise<{ id: string }> };

export const GET = routeAdmin("groups.read", async (_req, _s, ctx: Ctx) =>
  okAdmin(await detailGroupe(idUuid((await ctx.params).id, "GROUP_NOT_FOUND"))),
);

/** DELETE /api/admin/groups/:id — le groupe, ses messages et leurs fichiers. */
export const DELETE = routeAdmin("groups.delete", async (_req, _s, ctx: Ctx) =>
  okAdmin({ ok: true, ...(await supprimerGroupe(idUuid((await ctx.params).id, "GROUP_NOT_FOUND"))) }),
);
