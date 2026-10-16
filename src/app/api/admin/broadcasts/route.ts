import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { creerDiffusion, presenterDiffusion, traiterDiffusionsDues } from "@/lib/gestion/diffusions";
import { NOM_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";

const STATUT_DEPUIS_CONSOLE: Record<string, string> = {
  scheduled: "planifiee",
  running: "en_cours",
  completed: "terminee",
  partial_failed: "echec",
  cancelled: "annulee",
};

/**
 * GET /api/admin/broadcasts?page&limit&status — l'historique, plus les
 * diffusions planifiées à part (`scheduled`), comme l'attend la console.
 */
export const GET = routeAdmin("broadcasts.read", async (req) => {
  const p = req.nextUrl.searchParams;
  const page = Math.max(1, Number(p.get("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(p.get("limit")) || 20));
  const statut = STATUT_DEPUIS_CONSOLE[p.get("status") ?? ""];
  const where = statut ? { statut } : { statut: { not: "planifiee" } };

  const [lignes, total, planifiees] = await Promise.all([
    prisma.diffusion.findMany({ where, orderBy: { creeLe: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.diffusion.count({ where }),
    prisma.diffusion.findMany({ where: { statut: "planifiee" }, orderBy: { planifieeA: "asc" }, take: 20 }),
  ]);
  return okAdmin({
    items: lignes.map((d) => presenterDiffusion(d, NOM_COMPTE_OFFICIEL)),
    total,
    page,
    limit,
    scheduled: planifiees.map((d) => ({
      jobId: Number(d.id),
      scheduledAt: d.planifieeA,
      payload: { content: d.contenu, criteria: d.criteres, estimate: d.estimation, clientId: d.clientId },
    })),
  });
});

/**
 * POST /api/admin/broadcasts — enregistre la diffusion, et la lance juste
 * APRÈS la réponse si elle est immédiate : la console n'attend pas les envois.
 */
export const POST = routeAdmin("broadcasts.send", async (req, session) => {
  const d = await creerDiffusion(await req.json().catch(() => null), session);
  const immediate = d.planifieeA.getTime() <= Date.now() + 1000;
  if (immediate) after(() => traiterDiffusionsDues().then(() => undefined));
  if (!immediate) {
    return okAdmin(
      { scheduled: true, id: Number(d.id), clientId: d.clientId, scheduledAt: d.planifieeA, estimate: d.estimation },
      201,
    );
  }
  return okAdmin(presenterDiffusion(d, NOM_COMPTE_OFFICIEL), 201);
});
