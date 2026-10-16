import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";

/** GET /api/admin/villes?idPays&search — les villes d'un pays (50 au plus). */
export const GET = routeAdmin("villes.read", async (req) => {
  const p = req.nextUrl.searchParams;
  const idPays = Number(p.get("idPays"));
  const q = p.get("search")?.trim();
  const villes = await prisma.ville.findMany({
    where: {
      isDelete: false,
      ...(Number.isInteger(idPays) && idPays > 0 ? { idPays } : {}),
      ...(q ? { nom: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { nom: "asc" },
    take: 50,
  });
  return okAdmin({ items: villes.map((v) => ({ idVille: v.idville, libelle: v.nom, idPays: v.idPays })) });
});
