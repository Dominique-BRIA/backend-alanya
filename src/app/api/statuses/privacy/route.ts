import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { statusPrivacySchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { MODE_PAR_DEFAUT } from "@/lib/statut-audience.mjs";

/**
 * Réglage « Qui peut voir mes statuts ».
 *
 * ⚠️ `privacy` EST UN SEGMENT FIXE, il passe donc AVANT `[id]` dans le routage
 * de Next. Sans conséquence : les identifiants de statut sont des UUID, aucun
 * ne peut valoir « privacy ».
 */

// GET /api/statuses/privacy — mon audience et les personnes que j'y ai nommées.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const [reglage, entrees] = await Promise.all([
    prisma.statusPrivacy.findUnique({
      where: { userId },
      select: { mode: true },
    }),
    prisma.statusAudienceEntry.findMany({
      where: { userId },
      include: {
        other: {
          select: {
            id: true,
            nom: true,
            pseudo: true,
            publicNumber: true,
            avatarUrl: true,
          },
        },
      },
    }),
  ]);

  return ok({
    // Absence de ligne = le défaut. Aucun compte n'a besoin d'être migré.
    mode: reglage?.mode ?? MODE_PAR_DEFAUT,
    users: entrees.map((e) => ({
      userId: e.other.id,
      name: nomAffichage(e.other),
      publicNumber: e.other.publicNumber,
      avatarUrl: avatarPublicUrl(e.other.avatarUrl),
    })),
  });
});

// PUT /api/statuses/privacy — remplace le mode ET la liste.
export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  const data = statusPrivacySchema.parse(await req.json());

  // On ne se nomme pas soi-même : l'auteur voit toujours ses statuts, et la
  // ligne serait au mieux inutile.
  const cibles = [...new Set(data.userIds)].filter((id) => id !== userId);

  /*
   * ⚠️ REMPLACEMENT EN BLOC, DANS UNE TRANSACTION.
   *
   * L'écran envoie l'état complet de la liste, pas un delta : c'est ce qui
   * rend l'enregistrement rejouable sans effet de bord. Hors transaction, une
   * panne entre la suppression et la réinsertion laisserait l'audience VIDE —
   * donc, en mode « Partager avec… », plus personne. Le pire moment pour une
   * demi-écriture.
   */
  await prisma.$transaction([
    prisma.statusPrivacy.upsert({
      where: { userId },
      create: { userId, mode: data.mode },
      update: { mode: data.mode },
    }),
    prisma.statusAudienceEntry.deleteMany({ where: { userId } }),
    prisma.statusAudienceEntry.createMany({
      data: cibles.map((otherId) => ({ userId, otherId })),
      skipDuplicates: true,
    }),
  ]);

  return ok({ mode: data.mode, count: cibles.length });
});
