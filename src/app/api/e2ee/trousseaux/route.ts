import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * TOUTES MES COPIES DE TROUSSEAU — la restauration d'un nouveau téléphone.
 *
 * `GET /api/e2ee/trousseaux` → [{ convId, corps, majLe }]
 *
 * Voir `trousseaux/[convId]/route.ts` pour ce que contient une copie et
 * pourquoi le serveur ne peut pas la lire.
 *
 * ⚠️ FILTRÉ SUR LES GROUPES DONT JE SUIS ENCORE MEMBRE. Le départ efface déjà
 * la copie ; le filtre est la seconde ceinture, pour qu'une copie oubliée
 * (écrite par un appareil pendant qu'un autre quittait le groupe) ne rende
 * jamais à un ancien membre la clé d'un groupe qu'il a quitté.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const copies = await prisma.e2eeTrousseau.findMany({
    where: {
      userId,
      conv: { isGroup: true, e2eeActif: true, participants: { some: { userId, ...MEMBRE_ACTIF } } },
    },
    select: { convId: true, corps: true, majLe: true },
  });
  return ok({ trousseaux: copies });
});
