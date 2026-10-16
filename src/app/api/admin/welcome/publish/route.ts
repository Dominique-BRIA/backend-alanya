import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { publier } from "@/lib/gestion/bienvenue";

/** POST /api/admin/welcome/publish — le brouillon devient la version envoyée aux nouveaux comptes. */
export const POST = routeAdmin("welcome.publish", async (_req, session) => okAdmin(await publier(session)));
