import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { filActivite } from "@/lib/gestion/statistiques";

/** GET /api/admin/activity — les 30 derniers événements (inscriptions, appels, réunions, statuts). */
export const GET = routeAdmin("stats.read", async () => okAdmin(await filActivite()));
