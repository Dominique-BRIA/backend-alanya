import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { reponseCsv } from "@/lib/gestion/outils";
import { filtreComptes } from "@/lib/gestion/comptes";

/**
 * GET /api/admin/users/export — les comptes de la liste filtrée, en CSV.
 * ⚠️ DONNÉES PERSONNELLES : 50 000 lignes au plus.
 */
export const GET = routeAdmin("users.export", async (req) => {
  const lignes = await prisma.user.findMany({
    where: filtreComptes(req.nextUrl.searchParams),
    orderBy: { createdAt: "desc" },
    take: 50_000,
    include: { pays: { select: { libelle: true } } },
  });
  return reponseCsv(
    `comptes-${new Date().toISOString().slice(0, 10)}.csv`,
    ["alanyaID", "nom", "pseudo", "numero", "email", "pays", "type_compte", "exclu", "inscription", "derniere_activite"],
    lignes.map((u) => [
      u.id,
      u.nom,
      u.pseudo,
      u.publicNumber,
      u.email,
      u.pays?.libelle,
      u.typeCompte,
      u.exclus === 1 ? "oui" : "non",
      u.createdAt,
      u.lastSeen,
    ]),
  );
});
