import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { periode } from "@/lib/gestion/outils";
import { analyses } from "@/lib/gestion/statistiques";

/** GET /api/admin/analytics?from&to — messages, appels, statuts, réunions, comptes, appareils. */
export const GET = routeAdmin("stats.read", async (req) => okAdmin(await analyses(periode(req.nextUrl.searchParams))));
