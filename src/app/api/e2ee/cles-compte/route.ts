import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * GET /api/e2ee/cles-compte?ids=a,b,c — les clés de compte PUBLIQUES de ces
 * comptes (chiffrement des groupes v2, 11/11/2026) : de quoi leur emballer la
 * clé d'un groupe. `{ cles: [{ userId, version, publique }] }` ; un compte
 * sans clé est simplement absent.
 *
 * Des clés publiques : rien de secret. 500 comptes au plus par demande.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuth(async (req: NextRequest) => {
  const ids = [
    ...new Set(
      (req.nextUrl.searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => UUID.test(s)),
    ),
  ].slice(0, 500);
  if (ids.length === 0) return ok({ cles: [] });
  const cles = await prisma.e2eeCleCompte.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, version: true, publique: true },
  });
  return ok({ cles });
});
