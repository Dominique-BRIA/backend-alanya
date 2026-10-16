import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";

/**
 * GET /api/admin/audit?action&targetType&targetId&before&limit — le journal
 * des écritures des superroots, du plus récent au plus ancien. `before` est
 * l'id de la dernière ligne vue (pagination par curseur).
 */
export const GET = routeAdmin("audit.read", async (req) => {
  const p = req.nextUrl.searchParams;
  const where: Prisma.GestionAuditWhereInput = {};
  if (p.get("action")) where.action = p.get("action")!;
  if (p.get("targetType")) where.cibleType = p.get("targetType")!;
  if (p.get("targetId")) where.cibleId = p.get("targetId")!;
  if (p.get("admin")) where.admin = p.get("admin")!;
  const avant = p.get("before");
  if (avant && /^\d+$/.test(avant)) where.id = { lt: BigInt(avant) };
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
  const lignes = await prisma.gestionAudit.findMany({ where, orderBy: { id: "desc" }, take: limit });
  return okAdmin(
    lignes.map((l) => ({
      id: Number(l.id),
      action: l.action,
      route: l.route,
      targetType: l.cibleType,
      targetId: l.cibleId,
      reason: l.motif,
      ip: l.ip,
      statusCode: l.statutHttp,
      createdAt: l.creeLe,
      adminId: null,
      admin: l.admin,
      adminNom: l.adminNom,
      adminEmail: null,
    })),
  );
});
