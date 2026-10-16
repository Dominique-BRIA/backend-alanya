import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";

/**
 * GET /api/admin/entreprises — les entreprises d'alanyaCenter, en LECTURE :
 * de quoi cibler une diffusion sur leurs agents. Leur gestion reste à
 * alanyaCenter.
 */
export const GET = routeAdmin("broadcasts.read", async () => {
  const entreprises = await prisma.company.findMany({
    where: { isDelete: false },
    orderBy: { libelle: "asc" },
    select: { idCompany: true, libelle: true, _count: { select: { Users: true } } },
  });
  return okAdmin({
    items: entreprises.map((e) => ({ idCompany: e.idCompany, libelle: e.libelle, comptes: e._count.Users })),
  });
});
