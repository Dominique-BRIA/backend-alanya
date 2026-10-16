import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { listerDemandes } from "@/lib/gestion/verifications";

/** GET /api/admin/verifications?queue=pending|documents|renamed|decided|all&limit */
export const GET = routeAdmin("verifications.read", async (req) => {
  const p = req.nextUrl.searchParams;
  const limite = Math.min(500, Math.max(1, Number(p.get("limit")) || 100));
  return okAdmin({ requests: await listerDemandes(p.get("queue") ?? "pending", limite) });
});
