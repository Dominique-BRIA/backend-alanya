import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { bannir, rehabiliter } from "@/lib/gestion/comptes";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/admin/users/:id/ban — `{ reason? }` : exclu, sessions coupées. */
export const POST = routeAdmin("users.ban", async (req, session, ctx: Ctx) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  const corps = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const motif = typeof corps?.reason === "string" && corps.reason.trim() ? corps.reason.trim() : null;
  session.audit = { motif };
  await bannir(id, motif);
  return okAdmin({ ok: true });
});

/** DELETE /api/admin/users/:id/ban — réhabilite. */
export const DELETE = routeAdmin("users.unban", async (_req, _s, ctx: Ctx) => {
  await rehabiliter(idUuid((await ctx.params).id, "USER_NOT_FOUND"));
  return okAdmin({ ok: true });
});
