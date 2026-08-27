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
 * Cette entreprise ouvre-t-elle le répertoire à TOUS ses services ?
 *
 * 🔴 `company.collegue` — 0 = son propre service seulement, 1 = tous les
 * services de l'entreprise. Demandé par le user le 27/08/2026.
 *
 * ⚠️ VRAI PAR DÉFAUT, et par deux chemins : la colonne vaut 1 par défaut, et
 * une entreprise introuvable rend `true` ici. C'est le comportement d'avant ce
 * champ. Choisir l'inverse — fermer au moindre doute — aurait l'air prudent,
 * mais couperait la vue de tout le monde sur une simple lecture ratée, et
 * personne ne saurait pourquoi le répertoire s'est vidé.
 */
export async function tousLesServicesVisibles(idCompany: number): Promise<boolean> {
  const c = await prisma.company.findUnique({
    where: { idCompany },
    select: { collegue: true },
  });
  return (c?.collegue ?? 1) === 1;
}

/**
 * Les services auxquels J'APPARTIENS, en clés normalisées.
 *
 * ⚠️ UN AGENT PEUT N'EN AVOIR AUCUN — `10000999` est dans ce cas en production.
 * L'ensemble est alors vide, et le répertoire restreint ne montrera rien : c'est
 * la conséquence exacte du réglage, et la corriger ici en ouvrant tout
 * reviendrait à ignorer le réglage précisément pour ceux qu'il vise.
 *
 * ⚠️ CLÉS NORMALISÉES, comme partout dans ce fichier : la casse des libellés
 * varie déjà en base (« Assistance technique » et « Assistance Technique »).
 */
async function mesServices(
  idCompany: number,
  moiId: string,
): Promise<Set<string>> {
  const lignes = await prisma.center.findMany({
    where: { idCompany, users_alanyaID: moiId, nomService: { not: null } },
    select: { nomService: true },
  });
  return new Set(
    lignes
      .map((l) => (l.nomService ?? "").trim().toLocaleLowerCase("fr"))
      .filter((n) => n !== ""),
  );
}

/**
 * Les services de l'entreprise, avec leur effectif.
 *
 * ⚠️ UN SERVICE SANS COLLÈGUE EST RENDU QUAND MÊME, avec un effectif à zéro.
 * Le masquer ferait disparaître un service pourtant configuré, sans que rien
 * ne l'explique — et laisserait croire à une panne à celui qui sait qu'il
 * existe. Zéro est une information ; l'absence n'en est pas une.
 *
 * ⚠️ CELA NE VAUT QUE POUR LES SERVICES QU'ON A LE DROIT DE VOIR. Quand
 * `company.collegue` vaut 0, les autres ne sont pas rendus à zéro : ils ne sont
 * pas rendus du tout. Un service listé vide dirait son existence, et le réglage
 * demande précisément de la taire.
 */
export async function servicesDeLEntreprise(
  idCompany: number,
  moiId: string,
): Promise<ServiceCollegues[]> {
  // Le réglage de l'entreprise, et mes propres services quand il resserre.
  const ouvert = await tousLesServicesVisibles(idCompany);
  const miens = ouvert ? null : await mesServices(idCompany, moiId);

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
    // Répertoire resserré : les services dont je ne fais pas partie n'existent
    // pas pour moi — ils ne sont pas rendus vides, ils ne sont pas rendus.
    if (miens !== null && !miens.has(cle)) continue;
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
  /*
   * 🔴 LE RÉGLAGE EST REVÉRIFIÉ ICI, et pas seulement à la liste des services.
   *
   * Le client demande un service PAR SON NOM. Ne filtrer que la liste
   * laisserait quiconque connaît le nom d'un autre service — il suffit de
   * l'avoir vu avant que le réglage ne change — en lire les membres en
   * appelant directement la route. Une porte fermée sur l'écran mais ouverte
   * sur le réseau n'est pas fermée.
   */
  const ouvert = await tousLesServicesVisibles(idCompany);
  if (!ouvert) {
    const miens = await mesServices(idCompany, moiId);
    if (!miens.has(nomService.trim().toLocaleLowerCase("fr"))) return [];
  }

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
      /*
       * L'AGENCE DE L'AGENT, demandee par le user le 26/08/2026 pour s'afficher
       * sous son Alanya ID.
       *
       * 🔴 ELLE PASSE PAR `fonction`, PAS PAR UNE COLONNE DE `users`. Un
       * utilisateur n'a pas d'agence en propre : c'est sa FONCTION qui en
       * designe une. Mesure en production le 27/08/2026 : 4 agents sur 5 ont
       * exactement une fonction avec agence, le cinquieme n'en a aucune — la
       * liaison est donc reelle et alimentee, contrairement a
       * `center.idservice` (voir la note en tete de fichier).
       *
       * ⚠️ BORNEE A MON ENTREPRISE, et ce n'est pas de la ceinture inutile :
       * DEUX agences portent le libelle « Agence Bafoussam » en production, une
       * par entreprise. Sans cette borne, un rattachement errone ferait
       * afficher, sous le nom d'un collegue, l'agence d'une autre societe.
       *
       * ⚠️ `take: 1` : le schema autorise plusieurs fonctions par personne. Le
       * user demande UNE agence sous le numero ; le tri par identifiant rend ce
       * choix STABLE plutot qu'arbitraire — la meme agence a chaque lecture.
       */
      Fonctions: {
        where: { idAgence: { not: null }, agence: { idCompany } },
        orderBy: { idFonction: "asc" },
        take: 1,
        select: { agence: { select: { libelle: true } } },
      },
    },
  });

  return membres;
}

/**
 * TOUS les collègues de l'entreprise dont le nom ou le numéro correspond.
 *
 * 🔴 CETTE RECHERCHE NE PASSE PAS PAR LES SERVICES, ET C'EST TOUT SON INTÉRÊT.
 *
 * Un agent peut n'être rattaché à AUCUNE ligne `center` — c'est le cas de
 * `10000999` en production au 25/08/2026. La navigation service → collègues ne
 * peut donc pas l'atteindre : il existe, il est dans l'entreprise, et il est
 * introuvable. Chercher directement dans les agents de l'entreprise le rattrape.
 *
 * ⚠️ Bornée à MON entreprise. Un annuaire d'entreprise n'est pas un annuaire
 * mondial : sans cette borne, la recherche deviendrait un moyen d'énumérer les
 * comptes de toute la plateforme.
 */
export async function chercherCollegues(
  idCompany: number,
  requete: string,
  moiId: string,
) {
  const q = requete.trim();
  if (q === "") return [];

  /*
   * Le numéro est cherché sur ses CHIFFRES SEULS : il est affiché formaté
   * (« 10 00 00 01 ») dans toute l'application, et c'est sous cette forme que
   * l'utilisateur le recopie. Chercher la chaîne brute ne trouverait rien.
   */
  const chiffres = q.replace(/\D/g, "");

  /*
   * 🔴 LA RECHERCHE OBÉIT AU RÉGLAGE, ET C'EST LE POINT LE PLUS FACILE À RATER.
   *
   * Cette fonction ne passe VOLONTAIREMENT pas par les services — c'est écrit
   * en toutes lettres au-dessus, et c'est ce qui rattrape l'agent rattaché à
   * aucune ligne `center`. Mais quand l'entreprise resserre au service, ce
   * contournement devient une porte dérobée : chercher « a » listerait tous les
   * agents de la société, service par service, exactement ce que le réglage
   * interdit.
   *
   * On borne donc aux personnes de MES services. L'agent sans service ne trouve
   * alors plus personne — c'est la conséquence du réglage, assumée : son
   * entreprise a choisi que le répertoire s'arrête au service, et il n'en a pas.
   */
  const ouvert = await tousLesServicesVisibles(idCompany);
  let idsAutorises: string[] | null = null;
  if (!ouvert) {
    const miens = await mesServices(idCompany, moiId);
    if (miens.size === 0) return [];
    const lignes = await prisma.center.findMany({
      where: { idCompany, nomService: { not: null } },
      select: { nomService: true, users_alanyaID: true },
    });
    idsAutorises = [
      ...new Set(
        lignes
          .filter(
            (l) =>
              !!l.users_alanyaID &&
              miens.has((l.nomService ?? "").trim().toLocaleLowerCase("fr")),
          )
          .map((l) => l.users_alanyaID as string),
      ),
    ];
    if (idsAutorises.length === 0) return [];
  }

  return prisma.user.findMany({
    where: {
      idCompany,
      typeCompte: TYPE_COMPTE_AGENT,
      id: idsAutorises === null ? { not: moiId } : { in: idsAutorises, not: moiId },
      OR: [
        { nom: { contains: q, mode: "insensitive" } },
        { pseudo: { contains: q, mode: "insensitive" } },
        ...(chiffres !== "" ? [{ publicNumber: { contains: chiffres } }] : []),
      ],
    },
    select: {
      id: true,
      publicNumber: true,
      nom: true,
      pseudo: true,
      avatarUrl: true,
      isOnline: true,
      lastSeen: true,
      /*
       * L'AGENCE DE L'AGENT, demandee par le user le 26/08/2026 pour s'afficher
       * sous son Alanya ID.
       *
       * 🔴 ELLE PASSE PAR `fonction`, PAS PAR UNE COLONNE DE `users`. Un
       * utilisateur n'a pas d'agence en propre : c'est sa FONCTION qui en
       * designe une. Mesure en production le 27/08/2026 : 4 agents sur 5 ont
       * exactement une fonction avec agence, le cinquieme n'en a aucune — la
       * liaison est donc reelle et alimentee, contrairement a
       * `center.idservice` (voir la note en tete de fichier).
       *
       * ⚠️ BORNEE A MON ENTREPRISE, et ce n'est pas de la ceinture inutile :
       * DEUX agences portent le libelle « Agence Bafoussam » en production, une
       * par entreprise. Sans cette borne, un rattachement errone ferait
       * afficher, sous le nom d'un collegue, l'agence d'une autre societe.
       *
       * ⚠️ `take: 1` : le schema autorise plusieurs fonctions par personne. Le
       * user demande UNE agence sous le numero ; le tri par identifiant rend ce
       * choix STABLE plutot qu'arbitraire — la meme agence a chaque lecture.
       */
      Fonctions: {
        where: { idAgence: { not: null }, agence: { idCompany } },
        orderBy: { idFonction: "asc" },
        take: 1,
        select: { agence: { select: { libelle: true } } },
      },
    },
    // Un annuaire d'entreprise reste petit ; la borne protège du cas où il ne
    // le serait plus, sans jamais gêner l'usage normal.
    take: 50,
    orderBy: { nom: "asc" },
  });
}
