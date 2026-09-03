import { prisma } from "./prisma";
import { peutVoirStatuts, modeValide } from "./statut-audience.mjs";

/**
 * APPLIQUE LA RÈGLE D'AUDIENCE AUX DONNÉES.
 *
 * La règle elle-même n'est pas ici : elle vit dans `statut-audience.mjs`, sans
 * aucun import, pour rester exécutable (`node src/lib/statut-audience.mjs`).
 * Ce fichier ne fait que lui apporter les faits — qui est contact, qui a
 * bloqué qui, quel mode, qui est nommé dans la liste.
 *
 * 🔴 TOUS LES CHEMINS QUI EXPOSENT UN STATUT PASSENT PAR ICI : le fil, le
 * binaire d'un média, et l'enregistrement d'une vue. Un seul qui diverge, et
 * l'on retombe sur le défaut du 02/09 — une vignette listée dont le contenu
 * repart en 403.
 */

/**
 * Parmi [auteurIds], ceux dont [lecteurId] a le droit de voir les statuts.
 *
 * Une seule rafale de requêtes, quel que soit le nombre d'auteurs : la liste
 * d'audience n'est jamais chargée en entier, on demande seulement « le lecteur
 * y figure-t-il ? ». Un compte très suivi n'alourdit donc pas la lecture.
 */
export async function auteursVisiblesPour(
  lecteurId: string,
  auteurIds: string[],
): Promise<Set<string>> {
  const visibles = new Set<string>();
  if (auteurIds.length === 0) return visibles;

  // On se voit toujours soi-même, sans interroger quoi que ce soit.
  if (auteurIds.includes(lecteurId)) visibles.add(lecteurId);
  const autres = auteurIds.filter((id) => id !== lecteurId);
  if (autres.length === 0) return visibles;

  const [reglages, nommeChez, monRepertoire, blocages] = await Promise.all([
    prisma.statusPrivacy.findMany({
      where: { userId: { in: autres } },
      select: { userId: true, mode: true },
    }),
    prisma.statusAudienceEntry.findMany({
      where: { userId: { in: autres }, otherId: lecteurId },
      select: { userId: true },
    }),
    prisma.contact.findMany({
      where: { userId: lecteurId, contactId: { in: autres }, isBlocked: false },
      select: { contactId: true },
    }),
    /*
     * 🔴 LE BLOCAGE SE LIT DANS LES DEUX SENS, et c'était le vrai trou.
     *
     * Le fil ne regardait que `Contact.isBlocked`, tenu à jour quand MOI je
     * bloque quelqu'un. Quand quelqu'un me bloquait, ma ligne de contact
     * n'était pas touchée : je continuais de voir ses statuts.
     */
    prisma.blocked.findMany({
      where: {
        OR: [
          { alanyaID: lecteurId, idCallerBlock: { in: autres } },
          { alanyaID: { in: autres }, idCallerBlock: lecteurId },
        ],
      },
      select: { alanyaID: true, idCallerBlock: true },
    }),
  ]);

  const modes = new Map(reglages.map((r) => [r.userId, r.mode as string]));
  const designePar = new Set(nommeChez.map((l) => l.userId));
  const mesContacts = new Set(monRepertoire.map((c) => c.contactId));
  const bloques = new Set<string>();
  for (const b of blocages) {
    bloques.add(b.alanyaID === lecteurId ? b.idCallerBlock : b.alanyaID);
  }

  for (const auteur of autres) {
    const autorise = peutVoirStatuts({
      estAuteur: false,
      estContact: mesContacts.has(auteur),
      bloque: bloques.has(auteur),
      mode: modeValide(modes.get(auteur)),
      // La règle ne demande à la liste qu'une chose : « le lecteur y est-il ? ».
      // On lui donne donc la réponse, pas la liste — inutile de transporter
      // trois cents identifiants pour en tester un.
      liste: designePar.has(auteur) ? [lecteurId] : [],
      lecteurId,
    });
    if (autorise) visibles.add(auteur);
  }
  return visibles;
}

/** Cas unitaire : [lecteurId] voit-il les statuts de [auteurId] ? */
export async function peutVoirStatutsDe(
  lecteurId: string,
  auteurId: string,
): Promise<boolean> {
  if (lecteurId === auteurId) return true;
  const visibles = await auteursVisiblesPour(lecteurId, [auteurId]);
  return visibles.has(auteurId);
}

/**
 * Les comptes dont [lecteurId] pourrait voir un statut — avant filtrage.
 *
 * ⚠️ CE N'EST PAS SEULEMENT MON RÉPERTOIRE. Avec « Partager avec… », quelqu'un
 * qui ne m'a pas dans ses contacts — ou que je n'ai pas dans les miens — peut
 * me désigner explicitement. S'en tenir au répertoire rendrait ce mode
 * inopérant : la personne accorderait l'accès et je ne verrais jamais rien.
 */
export async function auteursCandidatsPour(lecteurId: string): Promise<string[]> {
  const [contacts, mOntNomme] = await Promise.all([
    prisma.contact.findMany({
      where: { userId: lecteurId, isBlocked: false },
      select: { contactId: true },
    }),
    prisma.statusAudienceEntry.findMany({
      where: { otherId: lecteurId },
      select: { userId: true },
    }),
  ]);

  const ids = new Set<string>([lecteurId]);
  for (const c of contacts) ids.add(c.contactId);
  for (const n of mOntNomme) ids.add(n.userId);
  return [...ids];
}
