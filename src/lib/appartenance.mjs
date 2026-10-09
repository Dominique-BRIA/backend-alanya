/**
 * QUI EST MEMBRE D'UNE CONVERSATION — une seule règle, un seul fichier.
 *
 * 🔴 DEPUIS LE 09/10/2026, UN PARTICIPANT QUI PART N'EST PLUS SUPPRIMÉ : il
 * reste dans `conv_participants`, avec `est_membre = false` (le `isMembre`
 * demandé par le user). C'est ce qui permet de savoir qui a eu accès, et de
 * refuser de lui servir la suite. Voir `prisma/manual/2026-10_e2ee_groupes.sql`
 * et le cours, chapitre 33.
 *
 * ⚠️ LA CONSÉQUENCE, ET ELLE EST DANGEREUSE : « avoir une ligne » ne veut plus
 * dire « être membre ». Chaque lecture de l'appartenance qui oublierait le
 * filtre servirait un ancien membre — messages, enveloppes, présence,
 * notifications. Il y en avait 38, dans 16 fichiers.
 *
 * D'où ce module : le filtre s'écrit `...MEMBRE_ACTIF`, partout, et
 * `scripts/appartenance-garde.mjs` refuse toute lecture de `participant` qui
 * ne le porte pas (sauf une liste blanche justifiée).
 *
 * `.mjs` pour être importé aussi par `ws-server.mjs`, qui ne lit pas le
 * TypeScript — comme `display-name.mjs`.
 */

/** Le filtre Prisma d'un membre ACTIF. À étaler dans chaque `where`. */
export const MEMBRE_ACTIF = Object.freeze({ estMembre: true });

/**
 * `userId` est-il membre ACTIF de `convId` ?
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} convId
 * @param {string} userId
 */
export async function estMembreActif(prisma, convId, userId) {
  const p = await prisma.participant.findFirst({
    where: { convId, userId, ...MEMBRE_ACTIF },
    select: { id: true },
  });
  return p !== null;
}

/**
 * Les identifiants des membres ACTIFS de `convId`.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} convId
 */
export async function membresActifs(prisma, convId) {
  const lignes = await prisma.participant.findMany({
    where: { convId, ...MEMBRE_ACTIF },
    select: { userId: true },
  });
  return lignes.map((l) => l.userId);
}

/**
 * Ce qu'on écrit sur la ligne d'un participant qui PART.
 * @param {string | null} excluPar l'administrateur qui exclut, `null` pour un
 *   départ volontaire.
 */
export function donneesDepart(excluPar) {
  return { estMembre: false, quitteLe: new Date(), excluPar };
}

/** Ce qu'on écrit sur la ligne d'un ancien membre qui REVIENT. */
export function donneesRetour() {
  return { estMembre: true, quitteLe: null, excluPar: null, joinedAt: new Date() };
}
