import { prisma } from "@/lib/prisma";

/**
 * L'ANNUAIRE DES COLLÈGUES — services d'une entreprise, et les agents qui y
 * répondent.
 *
 * ── OÙ VIT LA NOTION DE « SERVICE » ──────────────────────────────────────
 *
 * 🔴 DANS `center.nom_service`, ET NON DANS LA TABLE `service`.
 *
 * Les deux existent, et le choix n'est pas de confort. La table `service` est
 * le référentiel formel (« Service technique », « Service client »), mais
 * `center.idservice` est NULL sur TOUTES les lignes en production au
 * 25/08/2026 : aucun agent n'y est rattaché, et s'en servir afficherait des
 * services vides.
 *
 * `center`, lui, porte les deux informations sur la MÊME ligne — le nom du
 * service et l'agent qui le tient. C'est aujourd'hui le seul chemin qui relie
 * réellement une personne à un service.
 *
 * ⚠️ LE JOUR OÙ `center.idservice` SERA RENSEIGNÉ, c'est ici qu'il faudra
 * basculer, et nulle part ailleurs : les routes et les clients ne connaissent
 * que les fonctions ci-dessous.
 *
 * ── CE QU'EST UN COLLÈGUE ────────────────────────────────────────────────
 *
 * Un compte de `type_compte = 2` — un AGENT, une personne. Les comptes de type
 * 3 et 4 sont les standards eux-mêmes (« Assistance Technique », « Clients
 * Fidèles ») : ce ne sont pas des collègues, et `center.users_alanyaid` peut
 * pourtant les désigner (la touche « Réception » du standard 202020 se pointe
 * elle-même). Sans ce filtre, l'annuaire proposerait d'appeler un standard en
 * le présentant comme une personne.
 */

/** Le type de compte d'un agent. Voir la note ci-dessus. */
export const TYPE_COMPTE_AGENT = 2;

export interface ServiceCollegues {
  /** Le nom tel qu'il doit être montré. */
  nom: string;
  /** Nombre de collègues, MOI EXCLU — voir `membresDuService`. */
  effectif: number;
}

/**
 * Les services de l'entreprise, avec leur effectif.
 *
 * ⚠️ UN SERVICE SANS COLLÈGUE EST RENDU QUAND MÊME, avec un effectif à zéro.
 * Le masquer ferait disparaître un service pourtant configuré, sans que rien
 * ne l'explique — et laisserait croire à une panne à celui qui sait qu'il
 * existe. Zéro est une information ; l'absence n'en est pas une.
 */
export async function servicesDeLEntreprise(
  idCompany: number,
  moiId: string,
): Promise<ServiceCollegues[]> {
  const lignes = await prisma.center.findMany({
    where: { idCompany, nomService: { not: null } },
    select: { nomService: true, users_alanyaID: true },
  });

  // Les agents de l'entreprise, pour ne compter que de vraies personnes.
  const agents = await prisma.user.findMany({
    where: { idCompany, typeCompte: TYPE_COMPTE_AGENT },
    select: { id: true },
  });
  const estAgent = new Set(agents.map((a) => a.id));

  /*
   * Regroupement par nom, sur la valeur NETTOYÉE mais en gardant l'écriture
   * d'origine pour l'affichage.
   *
   * ⚠️ Les libellés sont saisis à la main depuis la plateforme de l'équipe, et
   * la casse varie déjà en production (« Assistance technique » et
   * « Assistance Technique » cohabitent dans `center.libelle`). Regrouper sur
   * la chaîne brute afficherait deux services là où il n'y en a qu'un.
   */
  const parCle = new Map<string, { nom: string; membres: Set<string> }>();
  for (const l of lignes) {
    const nom = (l.nomService ?? "").trim();
    if (nom === "") continue;
    const cle = nom.toLocaleLowerCase("fr");
    const entree = parCle.get(cle) ?? { nom, membres: new Set<string>() };
    // MOI EXCLU : « collègues » désigne les autres. Se voir dans sa propre
    // liste, avec un bouton pour s'appeler soi-même, n'a pas de sens.
    if (l.users_alanyaID && l.users_alanyaID !== moiId && estAgent.has(l.users_alanyaID)) {
      entree.membres.add(l.users_alanyaID);
    }
    parCle.set(cle, entree);
  }

  return [...parCle.values()]
    .map((e) => ({ nom: e.nom, effectif: e.membres.size }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

/**
 * Les collègues d'un service donné.
 *
 * La comparaison du nom est insensible à la casse, pour la même raison que le
 * regroupement ci-dessus : le client renvoie le nom qu'on lui a donné, mais la
 * base peut en porter plusieurs écritures.
 */
export async function membresDuService(
  idCompany: number,
  nomService: string,
  moiId: string,
) {
  const lignes = await prisma.center.findMany({
    where: { idCompany, nomService: { equals: nomService, mode: "insensitive" } },
    select: { users_alanyaID: true },
  });

  const ids = [...new Set(lignes.map((l) => l.users_alanyaID).filter((v): v is string => !!v))]
    .filter((id) => id !== moiId);
  if (ids.length === 0) return [];

  const membres = await prisma.user.findMany({
    where: {
      id: { in: ids },
      idCompany,
      // Seulement de vraies personnes — voir la note en tête de fichier.
      typeCompte: TYPE_COMPTE_AGENT,
    },
    select: {
      id: true,
      publicNumber: true,
      nom: true,
      pseudo: true,
      avatarUrl: true,
      isOnline: true,
      lastSeen: true,
    },
  });

  return membres;
}
