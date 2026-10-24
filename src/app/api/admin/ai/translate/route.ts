import { routeAdmin } from "@/lib/gestion/session";
import { erreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { rateLimit } from "@/lib/rate-limit";
import { traduire } from "@/lib/gestion/ia";

/** POST /api/admin/ai/translate — propose des traductions ; n'écrit rien (permis en lecture seule). */
export const POST = routeAdmin(
  "ai.editorial",
  async (req, session) => {
    const quota = await rateLimit(`gestion-ia:${session.userId}`, 30, 10 * 60_000);
    if (!quota.allowed) return erreurAdmin(429, "Trop de demandes, réessayez dans quelques minutes", "RATE_LIMITED");
    return okAdmin(await traduire(await req.json().catch(() => null)));
  },
  { lecture: true },
);
