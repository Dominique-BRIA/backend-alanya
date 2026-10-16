import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { compterFiles } from "@/lib/gestion/verifications";

/** GET /api/admin/verifications/count — à examiner, en attente de pièce, comptes renommés. */
export const GET = routeAdmin("verifications.read", async () => okAdmin(await compterFiles()));
