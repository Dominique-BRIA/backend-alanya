import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";

/** GET /api/admin/audit/actions — le vocabulaire réellement présent au journal, pour les filtres. */
export const GET = routeAdmin("audit.read", async () => {
  const lignes = await prisma.gestionAudit.groupBy({
    by: ["action"],
    _count: { _all: true },
    _max: { creeLe: true },
    orderBy: { _count: { action: "desc" } },
  });
  return okAdmin(lignes.map((l) => ({ action: l.action, n: l._count._all, derniere: l._max.creeLe })));
});
