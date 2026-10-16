import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { etatBienvenue } from "@/lib/gestion/bienvenue";

/** GET /api/admin/welcome — version publiée, brouillon, comptes jamais servis. */
export const GET = routeAdmin("welcome.read", async () => okAdmin(await etatBienvenue()));
