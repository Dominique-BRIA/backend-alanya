import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { presenterDiffusion } from "@/lib/gestion/diffusions";
import { NOM_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";

/** GET /api/admin/broadcasts/:id — une diffusion et son avancement. */
export const GET = routeAdmin(
  "broadcasts.read",
  async (_req, _session, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!/^\d{1,18}$/.test(id)) throw new ErreurAdmin(404, "Diffusion introuvable", "BROADCAST_NOT_FOUND");
    const d = await prisma.diffusion.findUnique({ where: { id: BigInt(id) } });
    if (!d) throw new ErreurAdmin(404, "Diffusion introuvable", "BROADCAST_NOT_FOUND");
    return okAdmin(presenterDiffusion(d, NOM_COMPTE_OFFICIEL));
  },
);
