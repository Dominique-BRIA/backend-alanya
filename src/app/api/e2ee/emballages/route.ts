import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail, HttpError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { deposerEmballages, lireChiffre, lireEntierPositif, type DemandeEmballage } from "@/lib/e2ee-v2";

/**
 * LES EMBALLAGES DE GROUPE — chiffrement des groupes v2 (11/11/2026),
 * conception § 3.2 et § 9.
 *
 * `GET [?convId=]` → mes emballages, dans les groupes chiffrés dont je suis
 *   encore membre : `{ emballages: [{ convId, version, versionCompte, corps, deposePar }] }`.
 * `PUT { convId, emballages: [{ userId, version, versionCompte, corps }] }` →
 *   `{ deposes, refuses: [{ userId, version, motif }] }`. Contrôles dans
 *   `deposerEmballages` (membre actif, version détenue, clé de compte à jour,
 *   historique caché respecté). Premier dépôt gagnant.
 * `DELETE { convId, version, versionCompte }` → retire UN de MES emballages,
 *   qui ne s'ouvre pas (clé de groupe illisible) : le rattrapage en redéposera
 *   un.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const convId = req.nextUrl.searchParams.get("convId");
  if (convId !== null && !UUID.test(convId)) return fail("convId invalide", 400, "BAD_ID");
  const emballages = await prisma.e2eeEmballage.findMany({
    where: {
      userId,
      ...(convId ? { convId } : {}),
      // La seconde ceinture, comme pour les copies de trousseau : un ancien
      // membre ne relit jamais la clé d'un groupe qu'il a quitté.
      conv: { isGroup: true, e2eeActif: true, participants: { some: { userId, ...MEMBRE_ACTIF } } },
    },
    select: { convId: true, version: true, versionCompte: true, corps: true, deposePar: true },
    orderBy: [{ convId: "asc" }, { version: "asc" }],
  });
  return ok({ emballages });
});

export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as { convId?: unknown; emballages?: unknown };
  if (typeof corps.convId !== "string" || !UUID.test(corps.convId)) {
    return fail("convId invalide", 400, "BAD_ID");
  }
  if (!Array.isArray(corps.emballages) || corps.emballages.length === 0) {
    return fail("Aucun emballage", 400, "VIDE");
  }
  if (corps.emballages.length > 2000) return fail("Trop d'emballages d'un coup", 413, "TROP");
  const demandes: DemandeEmballage[] = corps.emballages.map((brut) => {
    const e = (brut ?? {}) as { userId?: unknown; version?: unknown; versionCompte?: unknown; corps?: unknown };
    if (typeof e.userId !== "string" || !UUID.test(e.userId)) {
      throw new HttpError(400, "userId invalide", "BAD_ID");
    }
    return {
      userId: e.userId,
      version: lireEntierPositif(e.version, "version"),
      versionCompte: lireEntierPositif(e.versionCompte, "versionCompte"),
      corps: lireChiffre(e.corps, 512),
    };
  });
  return ok(await deposerEmballages(corps.convId, userId, demandes));
});

export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as {
    convId?: unknown;
    version?: unknown;
    versionCompte?: unknown;
  };
  if (typeof corps.convId !== "string" || !UUID.test(corps.convId)) {
    return fail("convId invalide", 400, "BAD_ID");
  }
  const r = await prisma.e2eeEmballage.deleteMany({
    where: {
      convId: corps.convId,
      userId,
      version: lireEntierPositif(corps.version, "version"),
      versionCompte: lireEntierPositif(corps.versionCompte, "versionCompte"),
    },
  });
  return ok({ retires: r.count });
});
