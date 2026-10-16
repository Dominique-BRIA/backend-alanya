import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurAdmin } from "@/lib/gestion/reponses";
import { demarrer, trajetActif } from "@/lib/gestion/trajets";

/**
 * Les trajets de confiance, côté APPLICATION.
 *
 * GET  /api/trajets — mon trajet en cours, ou `null`.
 * POST /api/trajets — `{ nature: taxi|walk|sos, dureeMinutes? }` : le démarre.
 * Puis `POST /api/trajets/:id/{points|prolonger|arrive|alerte|resolu|cloturer}`.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => ok({ trajet: await trajetActif(userId) }));

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    return ok(await demarrer(userId, await req.json().catch(() => null)), 201);
  } catch (e) {
    if (e instanceof ErreurAdmin) return fail(e.message, e.status, e.code);
    return handleError(e);
  }
});
