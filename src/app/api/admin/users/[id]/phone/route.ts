import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { changerNumero } from "@/lib/gestion/comptes";

/** PUT /api/admin/users/:id/phone — `{ alanyaPhone }`, historisé. */
export const PUT = routeAdmin("users.phone", async (req, session, ctx: { params: Promise<{ id: string }> }) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  const corps = (await req.json().catch(() => ({}))) as { alanyaPhone?: unknown };
  await changerNumero(id, String(corps?.alanyaPhone ?? ""), session);
  return okAdmin({ ok: true });
});
