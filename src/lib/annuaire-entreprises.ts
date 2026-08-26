import { prisma } from "@/lib/prisma";

/**
 * ANNUAIRE DES ENTREPRISES — types, entreprises, et les centres qu'on appelle.
 *
 * ── CE QUI EST MONTRÉ, ET À QUI ──────────────────────────────────────────
 *
 * La navigation est filtrée sur LE PAYS DE L'UTILISATEUR : on cherche à joindre
 * le service client d'une entreprise qu'on peut réellement appeler. La
 * RECHERCHE, elle, ignore ce filtre — c'est la demande explicite du user, et
 * c'est ce qui permet de trouver une entreprise étrangère qu'on connaît déjà par
 * son nom.
 *
 * ⚠️ UNE ENTREPRISE SANS PAYS N'APPARAÎT QUE DANS LA RECHERCHE. Elle ne peut
 * être rattachée à aucun pays, donc à aucune liste filtrée — mais la masquer
 * partout la rendrait introuvable. « Open solution » est dans ce cas en
 * production au 25/08/2026.
 *
 * ── CE QU'ON APPELLE ─────────────────────────────────────────────────────
 *
 * 🔴 L'ALANYA ID DU CENTRE, jamais le numéro court de l'entreprise. C'est lui
 * qu'on compose pour tomber sur le standard et son menu à touches, et chaque
 * centre a le sien. Le numéro court (`company.numero_court`) désigne
 * l'entreprise, pas un standard : il ne distingue pas les centres entre eux.
 */

/** Comptes de standard : 3 = centre d'appel, 4 = centre vocal. */
const TYPE_CENTRE_APPEL = 3;
const TYPE_CENTRE_VOCAL = 4;

/** Une entreprise « active ». La colonne est nullable, `null` vaut actif. */
const ACTIVE = { NOT: { actif: 0 } } as const;

export interface TypeEntreprise {
  idTypeCompany: number;
  libelle: string;
  /** Nombre d'entreprises VISIBLES pour cet appelant — pays compris. */
  nbEntreprises: number;
}

/**
 * Les types d'entreprise, avec le nombre d'entreprises que l'appelant verra
 * réellement derrière.
 *
 * ⚠️ LE COMPTE EST CELUI D'APRÈS FILTRE, pas le total. Annoncer « 12 » puis
 * n'en montrer aucune parce qu'aucune n'est dans le pays serait le pire des
 * deux mondes : l'utilisateur croit à une panne.
 */
export async function typesDEntreprise(idPaysUtilisateur: number | null): Promise<TypeEntreprise[]> {
  const types = await prisma.typeCompany.findMany({ orderBy: { libelle: "asc" } });

  const comptes = await prisma.company.groupBy({
    by: ["idTypeCompany"],
    where: { ...ACTIVE, ...filtrePays(idPaysUtilisateur) },
    _count: { _all: true },
  });
  const parType = new Map(comptes.map((c) => [c.idTypeCompany, c._count._all]));

  return types.map((t) => ({
    idTypeCompany: t.idTypeCompany,
    libelle: t.libelle,
    nbEntreprises: parType.get(t.idTypeCompany) ?? 0,
  }));
}

/**
 * Le filtre par pays.
 *
 * ⚠️ UN UTILISATEUR SANS PAYS VOIT TOUT. On ne peut pas filtrer sur une valeur
 * qu'on n'a pas, et lui montrer une liste vide serait lui dire qu'aucune
 * entreprise n'existe. Le cas est réel : `users.idPays` est nul pour la moitié
 * des comptes en production.
 */
function filtrePays(idPays: number | null) {
  return idPays == null ? {} : { idPays };
}

/** Les entreprises d'un type, dans MON pays. */
export async function entreprisesDuType(idTypeCompany: number, idPaysUtilisateur: number | null) {
  return prisma.company.findMany({
    where: { ...ACTIVE, idTypeCompany, ...filtrePays(idPaysUtilisateur) },
    orderBy: { libelle: "asc" },
    select: selectionEntreprise,
  });
}

/**
 * Recherche d'entreprise — SANS filtre de pays.
 *
 * 🔴 C'EST LA DEMANDE EXPLICITE DU USER, et c'est aussi le seul chemin vers une
 * entreprise sans pays. Chercher, c'est déjà savoir ce qu'on veut : on ne
 * découvre pas une entreprise étrangère par hasard, on la nomme.
 *
 * Le libellé ET les mots-clés sont fouillés : `company.motcles` existe pour ça —
 * une entreprise connue sous une marque différente de sa raison sociale reste
 * trouvable.
 */
export async function chercherEntreprises(requete: string) {
  const q = requete.trim();
  if (q === "") return [];

  return prisma.company.findMany({
    where: {
      ...ACTIVE,
      OR: [
        { libelle: { contains: q, mode: "insensitive" } },
        { motcles: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: { libelle: "asc" },
    // L'annuaire reste petit ; la borne protège du cas où il ne le serait plus.
    take: 50,
    select: selectionEntreprise,
  });
}

const selectionEntreprise = {
  idCompany: true,
  libelle: true,
  description: true,
  adresse: true,
  idPays: true,
  pays: { select: { libelle: true, iso2: true } },
  ville: { select: { nom: true } },
} as const;

export interface ServiceTouche {
  /** Le numéro de touche à composer dans le menu. */
  touche: number;

  /**
   * Le nom du service, ou `null` quand il n'est PAS renseigné.
   *
   * 🔴 `null` ET NON UN LIBELLÉ DE REPLI. Le serveur ne fabrique pas de nom :
   * c'est le client qui affichera « Sans nom », dans la langue de
   * l'utilisateur — l'application en parle neuf, et un repli écrit ici serait
   * du français servi à tout le monde.
   *
   * ⚠️ Ne pas y mettre « Touche N » non plus : ça RESSEMBLE à un nom de
   * service, et l'appelant croirait lire un intitulé réel. Le numéro de touche
   * voyage déjà dans [touche] — le client l'affiche à part, ce qui garde le
   * geste actionnable sans inventer d'intitulé.
   */
  nom: string | null;
}

export interface CentreEntreprise {
  /** `appel` = standard humain, `vocal` = serveur vocal. */
  type: "appel" | "vocal";
  nom: string;
  /** L'Alanya ID à composer. */
  alanyaId: string;
  services: ServiceTouche[];
}

/**
 * Les centres d'une entreprise, avec les services de chaque touche.
 *
 * ⚠️ LES CENTRES VIENNENT DE `users`, pas des tables de touches. Un centre qui
 * n'a encore AUCUNE touche configurée existe quand même, et on peut l'appeler :
 * le déduire des seules lignes `center` / `center_audio` l'aurait fait
 * disparaître de l'annuaire tant que personne ne l'a paramétré.
 */
export async function centresDeLEntreprise(idCompany: number): Promise<CentreEntreprise[]> {
  const comptes = await prisma.user.findMany({
    where: { idCompany, typeCompte: { in: [TYPE_CENTRE_APPEL, TYPE_CENTRE_VOCAL] } },
    select: { id: true, publicNumber: true, nom: true, pseudo: true, typeCompte: true },
    orderBy: { publicNumber: "asc" },
  });
  if (comptes.length === 0) return [];

  const ids = comptes.map((c) => c.id);

  const touchesAppel = await prisma.center.findMany({
    where: { center_alanyaID: { in: ids } },
    select: { center_alanyaID: true, menuNro: true, nomService: true, libelle: true },
  });
  const touchesVocal = await prisma.centerAudio.findMany({
    where: { center_alanyaID: { in: ids } },
    select: { center_alanyaID: true, menuNro: true, titre: true },
  });

  return comptes.map((compte) => {
    const estVocal = compte.typeCompte === TYPE_CENTRE_VOCAL;
    const nom = (compte.nom ?? compte.pseudo ?? "").trim() || compte.publicNumber;

    const services: ServiceTouche[] = estVocal
      ? touchesVocal
          .filter((t) => t.center_alanyaID === compte.id)
          .map((t) => ({
            touche: t.menuNro,
            // Vide en base → `null`. Les six touches vocales de la production
            // sont dans ce cas au 25/08/2026 : ce n'est pas un cas de bord,
            // c'est ce que l'écran affichera.
            nom: (t.titre ?? "").trim() || null,
          }))
      : touchesAppel
          .filter((t) => t.center_alanyaID === compte.id)
          .map((t) => ({
            touche: t.menuNro ?? 0,
            // `nom_service` est le nom À MONTRER à l'appelant ; `libelle` est le
            // nom interne de la ligne et ne sert que de repli. Les deux vides →
            // `null`, et c'est le client qui dira « Sans nom ».
            nom: (t.nomService ?? "").trim() || (t.libelle ?? "").trim() || null,
          }));

    // Dédoublonné par touche : la plateforme de l'équipe peut poser plusieurs
    // agents sur la MÊME touche (c'est le cas de la touche 1 du 202020), et
    // l'appelant, lui, ne compose ce chiffre qu'une fois.
    const parTouche = new Map<number, ServiceTouche>();
    for (const s of services) if (!parTouche.has(s.touche)) parTouche.set(s.touche, s);

    return {
      type: estVocal ? ("vocal" as const) : ("appel" as const),
      nom,
      alanyaId: compte.publicNumber,
      services: [...parTouche.values()].sort((a, b) => a.touche - b.touche),
    };
  });
}
