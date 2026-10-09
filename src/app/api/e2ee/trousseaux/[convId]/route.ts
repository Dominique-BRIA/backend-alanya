import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * MA COPIE DU TROUSSEAU D'UN GROUPE (lot 2c, conception § 3.5).
 *
 * `GET /api/e2ee/trousseaux/<convId>` → ma copie, pour la restaurer
 * `PUT /api/e2ee/trousseaux/<convId>` → la déposer ou la remplacer
 *   corps : { corps: "<chiffré opaque>" }
 *
 * La liste de toutes mes copies est à `GET /api/e2ee/trousseaux`.
 *
 * 🔴 LE SERVEUR NE PEUT PAS LA LIRE. Elle est chiffrée par la clé maîtresse
 * de l'ARCHIVE PERSONNELLE de son propriétaire, qui ne sort jamais de ses
 * appareils et s'ouvre avec son mot de passe (décision du user : pas de clé
 * de secours à retenir). C'est ce qui permet à un nouveau téléphone de relire
 * l'historique d'un groupe sans qu'aucun autre membre soit en ligne.
 *
 * ⚠️ RANGÉE À PART DE L'ARCHIVE DES MESSAGES, pour pouvoir être SUPPRIMÉE
 * SEULE : le serveur l'efface au départ ou à l'exclusion de son propriétaire
 * (routes `leave` et `members`), sans toucher au reste de son archive.
 */

/** Plafond, en caractères — le même que la contrainte SQL. */
const CORPS_MAX = 1_000_000;

/** Seul un membre ACTIF d'un groupe CHIFFRÉ a une copie à tenir. */
async function groupeAutorise(convId: string, userId: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id: convId, isGroup: true, e2eeActif: true, participants: { some: { userId, ...MEMBRE_ACTIF } } },
    select: { id: true },
  });
  return conv !== null;
}

export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { convId } = await ctx.params;
    if (!(await groupeAutorise(convId, userId))) {
      return fail("Groupe chiffré inconnu", 404, "NOT_FOUND");
    }
    const copie = await prisma.e2eeTrousseau.findUnique({
      where: { userId_convId: { userId, convId } },
      select: { corps: true, majLe: true },
    });
    if (!copie) return fail("Aucune copie de ce trousseau", 404, "AUCUNE_COPIE");
    return ok({ convId, corps: copie.corps, majLe: copie.majLe });
  },
);

export const PUT = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { convId } = await ctx.params;
    let brut: unknown;
    try {
      brut = await req.json();
    } catch {
      return fail("Corps JSON invalide", 400, "BAD_JSON");
    }
    const corps = (brut as { corps?: unknown } | null)?.corps;
    if (typeof corps !== "string" || corps.length === 0 || corps.length > CORPS_MAX) {
      return fail(`« corps » : une chaîne de 1 à ${CORPS_MAX} caractères`, 400, "BAD_BODY");
    }
    if (!(await groupeAutorise(convId, userId))) {
      return fail("Groupe chiffré inconnu", 404, "NOT_FOUND");
    }
    const copie = await prisma.e2eeTrousseau.upsert({
      where: { userId_convId: { userId, convId } },
      create: { userId, convId, corps },
      update: { corps, majLe: new Date() },
      select: { majLe: true },
    });
    return ok({ convId, majLe: copie.majLe });
  },
);
