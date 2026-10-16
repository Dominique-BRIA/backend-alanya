import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { ErreurAdmin } from "@/lib/gestion/reponses";
import { agir } from "@/lib/gestion/trajets";

/** POST /api/trajets/:id/{points|prolonger|arrive|alerte|resolu|cloturer} — sur SON trajet en cours. */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  try {
    const { id, action } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) return fail("Trajet introuvable", 404, "TRIP_NOT_FOUND");
    // Un téléphone envoie ses positions par paquets : 120 envois par heure suffisent largement.
    const quota = await rateLimit(`trajet:${userId}`, 120, 60 * 60_000);
    if (!quota.allowed) return fail("Trop d'envois, réessayez plus tard", 429, "RATE_LIMITED");
    return ok(await agir(userId, BigInt(id), action, await req.json().catch(() => ({}))));
  } catch (e) {
    if (e instanceof ErreurAdmin) return fail(e.message, e.status, e.code);
    return handleError(e);
  }
});
