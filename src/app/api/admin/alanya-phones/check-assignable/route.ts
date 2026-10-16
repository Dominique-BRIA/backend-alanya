import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { verifierNumero } from "@/lib/gestion/comptes";

/** GET /api/admin/alanya-phones/check-assignable?phone — ce numéro peut-il être attribué ? */
export const GET = routeAdmin("phones.read", async (req) =>
  okAdmin(await verifierNumero(req.nextUrl.searchParams.get("phone") ?? "")),
);
