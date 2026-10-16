import { routeAdmin } from "@/lib/gestion/session";
import { erreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { rateLimit } from "@/lib/rate-limit";
import { relire } from "@/lib/gestion/ia";

/** POST /api/admin/ai/review — relit un texte avant publication ; n'écrit rien. */
export const POST = routeAdmin(
  "ai.editorial",
  async (req, session) => {
    const quota = await rateLimit(`gestion-ia:${session.idRoot}`, 30, 10 * 60_000);
    if (!quota.allowed) return erreurAdmin(429, "Trop de demandes, réessayez dans quelques minutes", "RATE_LIMITED");
    return okAdmin(await relire(await req.json().catch(() => null)));
  },
  { lecture: true },
);
