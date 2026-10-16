import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { periode } from "@/lib/gestion/outils";
import { statistiques } from "@/lib/gestion/trajets";

/** GET /api/admin/trips?from&to — volumes et taux des trajets ; aucune identité, aucune position. */
export const GET = routeAdmin("trips.read", async (req) => okAdmin(await statistiques(periode(req.nextUrl.searchParams))));
