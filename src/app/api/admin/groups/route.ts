import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { listerGroupes } from "@/lib/gestion/plateforme";

/** GET /api/admin/groups?search — les 500 groupes les plus actifs. */
export const GET = routeAdmin("groups.read", async (req) =>
  okAdmin(await listerGroupes(req.nextUrl.searchParams.get("search")?.trim() || null)),
);
