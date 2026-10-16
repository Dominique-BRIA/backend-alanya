import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { retention } from "@/lib/gestion/trajets";

/** GET /api/admin/trips/retention — politique, volumes stockés et effaçables, passages. */
export const GET = routeAdmin("trips.read", async () => okAdmin(await retention()));
