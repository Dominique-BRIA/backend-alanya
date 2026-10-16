import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { etatIa } from "@/lib/gestion/ia";

/** GET /api/admin/ai/status — l'assistance est-elle disponible (clé configurée) ? */
export const GET = routeAdmin("profile.read", async () => okAdmin(etatIa()));
