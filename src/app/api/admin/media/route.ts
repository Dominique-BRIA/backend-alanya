import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { listerMedias } from "@/lib/gestion/plateforme";

/** GET /api/admin/media?type&limit — les médias envoyés récemment (jamais les chiffrés). */
export const GET = routeAdmin("media.read", async (req) => okAdmin(await listerMedias(req.nextUrl.searchParams)));
