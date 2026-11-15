import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * GET /api/users/:id/fiche — ce que la FICHE CONTACT doit connaître d'une
 * personne et qu'aucune liste ne lui donnait (15/11/2026, user : « Bloquer
 * n'affiche pas l'état réel, le statut est absent »).
 *
 *   - `statusMsg` : son message de statut (la « bio ») ;
 *   - `bloque`    : je l'ai bloquée.
 *
 * ⚠️ JAMAIS « ELLE M'A BLOQUÉ » : ce serait le lui révéler.
 *
 * ⚠️ SEULEMENT POUR UNE PERSONNE QUE JE CONNAIS : un fil en commun (à deux ou
 * en groupe, membres actifs) ou mon répertoire. Sinon 404, comme un compte
 * inexistant : on ne lit pas le statut de n'importe qui par son identifiant.
 */
export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const autreId = (await ctx.params).id;
    if (!autreId || autreId === userId) return fail("Fiche inconnue", 404, "NOT_FOUND");

    const [filCommun, contact, autre, blocage] = await Promise.all([
      prisma.conversation.findFirst({
        where: {
          AND: [
            { participants: { some: { userId, ...MEMBRE_ACTIF } } },
            { participants: { some: { userId: autreId, ...MEMBRE_ACTIF } } },
          ],
        },
        select: { id: true },
      }),
      prisma.contact.findFirst({ where: { userId, contactId: autreId }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: autreId }, select: { statusMsg: true } }),
      prisma.blocked.findFirst({
        where: { alanyaID: userId, idCallerBlock: autreId },
        select: { idBlock: true },
      }),
    ]);
    if (!autre || (!filCommun && !contact)) return fail("Fiche inconnue", 404, "NOT_FOUND");

    return ok({
      statusMsg: autre.statusMsg ?? null,
      bloque: blocage !== null,
    });
  },
);
