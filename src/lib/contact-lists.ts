import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { comptesParNumerosPublics } from "./publicNumber";
import { nomAffichage } from "./display-name.mjs";

// Listes de contacts — helpers partages par /api/contact-lists et
// /api/contact-lists/[id]. Les deux routes doivent rendre la MEME forme JSON et
// le meme 409 : la dupliquer de part et d'autre finirait par les faire diverger.

/// Un membre de liste, tel qu'il sort du serveur.
///
/// Un membre n'est PLUS forcement un contact : on peut desormais ajouter a une
/// liste un numero compose au clavier, qui n'est pas au repertoire. D'ou les deux
/// champs qui n'existaient pas quand la reponse ne portait que des identifiants :
/// `publicNumber`, toujours present, pour que le client puisse afficher la ligne
/// meme sans nom, et `isContact`, pour qu'il sache s'il a autre chose a afficher.
export interface MembreJson {
  id: string;
  publicNumber: string;
  name: string | null;
  isContact: boolean;
}

/// Forme d'une liste telle qu'elle sort du serveur. C'est le contrat, les
/// clients (web et Flutter) s'y adossent au caractere pres.
export interface ListeJson {
  id: string;
  name: string;
  ringtone: string | null;
  color: string | null;
  createdAt: string;
  members: MembreJson[];
}

/// Ligne Prisma minimale attendue en entree — c'est ce que `AVEC_MEMBRES` charge.
interface LigneListe {
  id: string;
  name: string;
  ringtone: string | null;
  color: string | null;
  createdAt: Date;
  members: {
    memberId: string;
    member: { publicNumber: string; nom: string | null; pseudo: string | null };
  }[];
}

/// Ordre de restitution des listes : ANCIENNETE DE CREATION croissante.
///
/// Ce n'est pas un detail d'affichage. Le client arbitre la sonnerie d'un
/// correspondant qui figure dans plusieurs listes par « la plus anciennement
/// creee gagne » : sans cet ordre, la sonnerie d'un meme appel changerait d'une
/// lecture a l'autre. Un ORDER BY explicite donc, jamais l'ordre naturel de
/// l'index — celui-la n'est garanti par rien et change avec le plan de requete.
///
/// `id` en second rang parce que `created_at` seul n'est pas un ordre TOTAL :
/// deux listes creees dans la meme milliseconde se departageraient au hasard, et
/// deux lectures successives pourraient les rendre dans l'ordre inverse.
const ORDRE_LISTES: Prisma.ContactListOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/// Ordre de restitution des membres : DATE D'AJOUT croissante.
///
/// Meme raison qu'au-dessus pour le second critere, et elle joue ici presque
/// toujours : un remplacement de membres insere toutes les lignes dans la meme
/// transaction, donc a l'horloge de la transaction, donc a `created_at` egal.
/// Le departage sur `idFriend` — et non sur la cle de la ligne, qui est tiree au
/// hasard a chaque reecriture — a une propriete que le client voit : reenregistrer
/// le MEME ensemble de membres rend le meme ordre, alors qu'un tri sur la cle de
/// ligne rebattrait l'affichage a chaque enregistrement sans que rien n'ait
/// change.
const ORDRE_MEMBRES: Prisma.ContactListMemberOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { memberId: "asc" },
];

/// Chargement systematique des membres : une liste sans ses membres n'a pas de
/// sens pour le client, qui l'affiche par son effectif.
///
/// Le compte membre est joint (`member`) parce que `publicNumber` est desormais
/// obligatoire dans la reponse : c'est la seule designation dont le client
/// dispose toujours, y compris pour un numero compose qui n'est pas au
/// repertoire et n'a donc pas d'alias.
export const AVEC_MEMBRES = {
  members: {
    orderBy: ORDRE_MEMBRES,
    select: {
      memberId: true,
      member: { select: { publicNumber: true, nom: true, pseudo: true } },
    },
  },
} as const;

/// Les listes de l'appelant, membres compris, dans l'ordre du contrat.
export async function listesDe(userId: string) {
  return prisma.contactList.findMany({
    // Le `where` sur userId n'est pas qu'un filtre d'affichage : une liste
    // n'appartient qu'a son createur et ne doit jamais fuir vers un autre compte.
    where: { userId },
    orderBy: ORDRE_LISTES,
    include: AVEC_MEMBRES,
  });
}

/// Un UUID, tel que Postgres l'accepte dans un `IN (...)` sur une colonne UUID.
/// Filtrer avant la requete evite qu'un identifiant abime cote client fasse
/// remonter une erreur de cast au lieu d'etre simplement ignore.
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/// Le repertoire de l'appelant, restreint aux comptes cites.
///
/// La PRESENCE d'une cle vaut `isContact`, la valeur est l'alias local. Les deux
/// se lisent d'une seule requete pour TOUTE la reponse — y compris quand elle
/// porte plusieurs listes : un `isContact` par membre ferait autant d'allers-
/// retours qu'il y a de personnes a l'ecran.
export async function repertoireDe(
  userId: string,
  memberIds: string[],
): Promise<Map<string, string | null>> {
  const cites = [...new Set(memberIds)];
  if (cites.length === 0) return new Map();

  const contacts = await prisma.contact.findMany({
    where: { userId, contactId: { in: cites } },
    select: { contactId: true, alias: true },
  });

  return new Map(contacts.map((c) => [c.contactId, c.alias] as const));
}

export function jsonListe(
  liste: LigneListe,
  repertoire: Map<string, string | null>,
): ListeJson {
  return {
    id: liste.id,
    name: liste.name,
    ringtone: liste.ringtone,
    color: liste.color,
    createdAt: liste.createdAt.toISOString(),
    members: liste.members.map((m) => {
      const alias = repertoire.get(m.memberId)?.trim();

      // `nomAffichage` porte la regle « le nom d'abord, le pseudo en repli » ;
      // la redire ici donnerait deux verites a garder d'accord. Le numero n'est
      // PAS passe a dessein : ce repli-la a sa place dans le champ
      // `publicNumber`, et le contrat veut `name: null` quand le compte n'a ni
      // nom ni pseudo — le client decide alors lui-meme quoi montrer.
      const nomDuCompte: string | null =
        nomAffichage({ nom: m.member.nom, pseudo: m.member.pseudo }) ?? null;

      return {
        id: m.memberId,
        publicNumber: m.member.publicNumber,
        // L'alias du repertoire passe devant le nom du compte : c'est sous ce
        // nom-la que l'appelant connait la personne.
        name: alias || nomDuCompte,
        isContact: repertoire.has(m.memberId),
      };
    }),
  };
}

/// Ne retient que les comptes qui sont DEJA des contacts de l'appelant, et
/// ecarte les autres en silence.
///
/// Sans ce filtre, un identifiant devine ou recopie ferait entrer n'importe quel
/// compte dans une liste — c'est la protection contre l'enumeration par
/// identifiant. Elle ne s'applique qu'a `memberIds` : un numero, lui, doit deja
/// etre connu pour etre compose, ce qui suffit (voir `membresResolus`).
/// L'ecart est silencieux a dessein : le client vient de composer sa liste a
/// partir de son propre repertoire, un refus ne lui apprendrait rien d'utile, et
/// il relit de toute facon `members` dans la reponse.
async function contactsRetenus(userId: string, memberIds: string[]): Promise<string[]> {
  const demandes = [...new Set(memberIds.filter((id) => UUID_REGEX.test(id)))];
  if (demandes.length === 0) return [];

  const contacts = await prisma.contact.findMany({
    where: { userId, contactId: { in: demandes } },
    select: { contactId: true },
  });

  // On rend les identifiants tels que la BASE les porte, jamais ceux du client.
  //
  // La colonne est de type UUID : Postgres compare donc sans egard a la casse et
  // trouve bien la ligne quand le client envoie ses [A-F] en majuscules — ce que
  // UUID_REGEX accepte. Le filtre qui etait ici comparait ensuite la chaine BRUTE
  // du client aux valeurs rendues par Prisma, toujours minuscules, et rejetait ce
  // que la base venait de trouver : un contact bien reel repondait 201 avec un
  // ensemble de membres vide. Repartir de la base est plus solide qu'un
  // `toLowerCase()` de part et d'autre — il n'y a plus qu'une seule forme en
  // circulation — et cela dedoublonne au passage.
  return contacts.map((c) => c.contactId);
}

/// L'ensemble des membres a inscrire, et les numeros restes sans compte.
export interface MembresResolus {
  /// Identifiants de comptes, dedoublonnes.
  ids: string[];
  /// Numeros demandes qu'AUCUN compte ne porte, dans leur forme normalisee.
  unknownNumbers: string[];
}

/// Resout les deux facons de designer un membre en un seul ensemble.
///
/// Les identifiants doivent etre des contacts, les numeros n'ont pas a l'etre :
/// on peut composer au clavier le numero de quelqu'un qui n'est pas au
/// repertoire. La propriete de securite tient quand meme, parce qu'il faut
/// connaitre le numero pour le composer — un identifiant, lui, se recopie.
///
/// Les numeros sans compte ne sont PAS abandonnes en silence : ils repartent dans
/// `unknownNumbers` pour que l'interface puisse dire lequel n'existe pas. Les
/// perdre sans rien dire laisserait l'utilisateur devant une liste plus courte
/// que ce qu'il a saisi, sans explication.
export async function membresResolus(
  userId: string,
  memberIds: string[] | undefined,
  memberNumbers: string[] | undefined,
): Promise<MembresResolus> {
  const ids: string[] = [];
  const deja = new Set<string>();

  // Le compte de l'appelant est ecarte : on ne se met pas dans sa propre liste.
  // Comparaison en minuscules par prudence — les identifiants viennent ici de la
  // base, mais `userId` a fait le detour du jeton, et une liste dont un membre
  // est son proprietaire n'aurait aucun sens a l'ecran.
  const soi = userId.toLowerCase();
  const retiens = (id: string) => {
    if (id.toLowerCase() === soi || deja.has(id)) return;
    deja.add(id);
    ids.push(id);
  };

  if (memberIds && memberIds.length > 0) {
    for (const id of await contactsRetenus(userId, memberIds)) retiens(id);
  }

  const unknownNumbers: string[] = [];
  if (memberNumbers && memberNumbers.length > 0) {
    // Meme resolution que POST /api/contacts, et non une seconde ecriture de la
    // meme chose : voir `comptesParNumerosPublics`.
    const comptes = await comptesParNumerosPublics(memberNumbers);
    for (const numero of [...new Set(memberNumbers)]) {
      const id = comptes.get(numero);
      if (id) retiens(id);
      else unknownNumbers.push(numero);
    }
  }

  return { ids, unknownNumbers };
}

/// Nom deja utilise par une autre liste du meme compte.
///
/// Ce 409 ne passe pas par `fail()` : le contrat convenu porte `{ error:
/// "name-taken" }`, une chaine et non l'objet `{ message, code }` du reste de
/// l'API. Le contrat fait foi, sinon le client ne reconnait pas le cas et
/// affiche une erreur generique la ou il doit designer le champ « nom ».
export function reponseNomDejaPris() {
  return NextResponse.json({ error: "name-taken" }, { status: 409 });
}

/// Violation d'unicite Prisma. Sert de garde-fou apres la verification explicite
/// du nom : entre la lecture et l'ecriture, deux appareils du meme compte
/// peuvent creer la meme liste, et c'est encore un « nom deja pris », pas une
/// erreur 400 indechiffrable.
export function estDoublonUnique(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}
