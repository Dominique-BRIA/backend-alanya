import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { estimer } from "@/lib/gestion/diffusions";

/**
 * POST /api/admin/broadcasts/estimate — `{ criteria }` → `{ count, criteria }`.
 * Les dates relatives reviennent gelées : c'est ce que la création comparera.
 * Ne modifie rien : permis en lecture seule.
 */
export const POST = routeAdmin(
  "broadcasts.read",
  async (req) => {
    const corps = (await req.json().catch(() => null)) as { criteria?: unknown } | null;
    return okAdmin(await estimer(corps?.criteria));
  },
  { lecture: true },
);
