import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { annulerDiffusion } from "@/lib/gestion/diffusions";

/**
 * DELETE /api/admin/broadcasts/scheduled/:jobId — annule une diffusion
 * planifiée qui n'a pas encore commencé (404 sinon). `jobId` est l'id de la
 * diffusion : la console d'origine parlait d'une tâche de file, nous n'en
 * avons pas.
 */
export const DELETE = routeAdmin(
  "broadcasts.cancel",
  async (_req, _session, ctx: { params: Promise<{ jobId: string }> }) => {
    const { jobId } = await ctx.params;
    if (!/^\d{1,18}$/.test(jobId)) throw new ErreurAdmin(404, "Diffusion planifiée introuvable", "JOB_NOT_FOUND");
    await annulerDiffusion(BigInt(jobId));
    return okAdmin({ ok: true });
  },
);
