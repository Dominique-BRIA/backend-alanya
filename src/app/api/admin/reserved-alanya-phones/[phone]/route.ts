import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { numeroCanonique } from "@/lib/gestion/comptes";

/** DELETE /api/admin/reserved-alanya-phones/:phone — libère la réservation (le porteur garde son numéro). */
export const DELETE = routeAdmin("phones.release", async (_req, _s, ctx: { params: Promise<{ phone: string }> }) => {
  const numero = numeroCanonique(decodeURIComponent((await ctx.params).phone));
  const r = await prisma.reservedAlanyaPhone.deleteMany({ where: { phoneCanonical: numero } });
  if (r.count === 0) throw new ErreurAdmin(404, "Numéro non réservé", "NOT_FOUND");
  return okAdmin({ ok: true });
});
