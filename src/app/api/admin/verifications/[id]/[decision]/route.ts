import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { decider } from "@/lib/gestion/verifications";

/**
 * POST /api/admin/verifications/:id/:decision — approve | refuse |
 * request-document | revoke | reconfirm, avec `{ reason }` (requis pour
 * refuser, demander une pièce ou révoquer). Rend la demande à jour.
 */
export const POST = routeAdmin(
  "verifications.decide",
  async (req, session, ctx: { params: Promise<{ id: string; decision: string }> }) => {
    const { id, decision } = await ctx.params;
    const corps = (await req.json().catch(() => ({}))) as { reason?: unknown };
    return okAdmin(await decider(idNumerique(id, "VERIFICATION_NOT_FOUND"), decision, corps?.reason, session));
  },
);
