import { prisma } from "@/lib/prisma";
import { estCompteCentre } from "@/lib/ivr.mjs";

/**
 * Centres pour lesquels cet utilisateur agit comme AGENT.
 *
 * Deux façons d'en être un : ÊTRE le compte centre lui-même (touche 0,
 * implicite ou explicite — voir `lireMenuCentre`), ou être listé comme
 * `users_alanyaID` d'une ligne `center` (touches 1/2/3...). Un même compte
 * peut couvrir plusieurs centres — rien ne l'interdit dans le référentiel.
 *
 * Sert de garde sur tout ce qui touche à la file d'attente en LECTURE (qui
 * attend, qui a abandonné) : sans elle, `/api/queue/history` était ouvert à
 * n'importe quel compte connecté, centre ou pas — corrigé le 15/08/2026.
 */
export async function centresDeLAgent(userId: string): Promise<string[]> {
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, typeCompte: true },
  });
  if (!moi) return [];

  const centres = new Set<string>();
  if (estCompteCentre(moi)) centres.add(moi.id);

  const lignes = await prisma.center.findMany({
    where: { users_alanyaID: userId, center_alanyaID: { not: null } },
    select: { center_alanyaID: true },
  });
  for (const l of lignes) {
    if (l.center_alanyaID) centres.add(l.center_alanyaID);
  }

  return [...centres];
}
