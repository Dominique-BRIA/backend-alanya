import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { listerReunions } from "@/lib/gestion/plateforme";

/** GET /api/admin/meetings — les 500 réunions les plus récentes. */
export const GET = routeAdmin("meetings.read", async () => okAdmin(await listerReunions()));
