import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { z } from "zod";

/**
 * Pseudo d'appareil — colonne `nom_agent` de la table `Appareil`.
 *
 * Ce n'est PAS un nom d'affichage : il n'apparaît ni dans les contacts, ni dans
 * le profil. C'est une étiquette « quel appareil a envoyé ce message », visible
 * uniquement par les autres appareils du même compte. Cas d'usage : un numéro
 * professionnel partagé entre plusieurs agents, où chacun veut savoir qui — dans
 * son équipe — a répondu.
 *
 * La ligne visée est celle du couple (compte, appareil) : `Appareil` est unique
 * sur (cookiesWebId, alanyaId), donc deux comptes utilisés dans le même
 * navigateur gardent chacun leur pseudo.
 */

/** Retrouve la ligne d'appareil du compte courant, par son identifiant client. */
async function ligneAppareil(userId: string, cookiesWebId: string | null) {
  if (!cookiesWebId) return null;
  return prisma.appareil.findFirst({
    where: { alanyaId: userId, cookiesWebId },
    select: { appareilId: true, agent: true },
  });
}

/**
 * GET /api/appareils/nom-agent?cookiesWebId=… — pseudo enregistré, ou null.
 *
 * Null n'est pas une erreur : c'est la réponse normale la première fois qu'un
 * compte se connecte sur cet appareil, et c'est elle qui déclenche la demande
 * de pseudo côté client.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const cookiesWebId = req.nextUrl.searchParams.get("cookiesWebId");
  const ligne = await ligneAppareil(userId, cookiesWebId);
  return ok({ nomAgent: ligne?.agent ?? null });
});

const corpsSchema = z.object({
  cookiesWebId: z.string().trim().min(1).max(255),
  nomAgent: z.string().trim().min(1).max(50),
});

/** POST /api/appareils/nom-agent — enregistre ou remplace le pseudo. */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = corpsSchema.parse(await req.json());

  // On écrit sur la ligne du compte COURANT et d'aucun autre : l'appartenance
  // ne se déduit pas de ce que le client affirme, elle se vérifie ici.
  const ligne = await ligneAppareil(userId, body.cookiesWebId);
  if (!ligne) return fail("Appareil inconnu pour ce compte", 404, "NOT_FOUND");

  /**
   * Le pseudo est unique au sein du compte : deux postes appelés « Accueil »
   * rendraient inutile la réponse à « qui a envoyé ce message ».
   *
   * L'index le garantit ; ce contrôle est là pour répondre une phrase
   * compréhensible plutôt qu'une violation de contrainte. Deux numéros Alanya
   * différents gardent chacun leur « Accueil » — la contrainte porte sur le
   * couple (compte, pseudo).
   */
  const pris = await prisma.appareil.findFirst({
    where: {
      alanyaId: userId,
      agent: body.nomAgent,
      appareilId: { not: ligne.appareilId },
    },
    select: { appareilId: true },
  });
  if (pris) {
    return fail(
      "Un autre appareil de ce compte porte déjà ce nom",
      409,
      "NAME_TAKEN",
    );
  }

  const maj = await prisma.appareil.update({
    where: { appareilId: ligne.appareilId },
    data: { agent: body.nomAgent },
    select: { appareilId: true, agent: true },
  });
  return ok({ appareilId: maj.appareilId, nomAgent: maj.agent });
});
