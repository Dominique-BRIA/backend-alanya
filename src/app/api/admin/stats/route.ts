import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { periode } from "@/lib/gestion/outils";
import { tableauDeBord } from "@/lib/gestion/statistiques";

/** GET /api/admin/stats?from&to — compteurs, courbes, pays et comptes les plus actifs. */
export const GET = routeAdmin("stats.read", async (req) => okAdmin(await tableauDeBord(periode(req.nextUrl.searchParams))));
