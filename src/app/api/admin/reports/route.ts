import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { pagination } from "@/lib/gestion/outils";
import { listerSignalements } from "@/lib/gestion/signalements";

/** GET /api/admin/reports?state&search&page&limit — la file de modération, et le nombre d'ouverts. */
export const GET = routeAdmin("reports.read", async (req) => {
  const p = req.nextUrl.searchParams;
  return okAdmin(await listerSignalements(p, pagination(p)));
});
