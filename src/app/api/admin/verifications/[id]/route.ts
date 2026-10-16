import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { detailDemande } from "@/lib/gestion/verifications";

/** GET /api/admin/verifications/:id — la demande, le compte, les pièces, l'historique. */
export const GET = routeAdmin("verifications.read", async (_req, _s, ctx: { params: Promise<{ id: string }> }) =>
  okAdmin(await detailDemande(idNumerique((await ctx.params).id, "VERIFICATION_NOT_FOUND"))),
);
