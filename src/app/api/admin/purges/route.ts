import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { listerPurges } from "@/lib/gestion/purges";

/** GET /api/admin/purges — chaque purge, ses réglages, ce qu'elle effacerait, ses passages. */
export const GET = routeAdmin("purges.read", async () => okAdmin({ purges: await listerPurges() }));
