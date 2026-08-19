import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// Catalogue de sonneries — helpers partages par /api/ringtones et
// /api/ringtones/[id]. Meme raison qu'a cote pour les listes : les deux routes
// doivent rendre la MEME forme JSON, la dupliquer les ferait diverger.

/// Une entree de catalogue, telle qu'elle sort du serveur. C'est le contrat, les
/// clients (web et Flutter) s'y adossent au caractere pres.
export interface SonnerieJson {
  id: string;
  url: string;
  label: string;
  createdAt: string;
}

/// Ligne Prisma minimale attendue en entree.
interface LigneSonnerie {
  id: string;
  url: string;
  label: string;
  createdAt: Date;
}

/// Ordre de restitution : ANCIENNETE D'IMPORT croissante.
///
/// Un ORDER BY explicite, jamais l'ordre naturel de l'index — celui-la n'est
/// garanti par rien et change avec le plan de requete. Ce n'est pas un detail
/// d'affichage : tout l'objet de cette table est que l'utilisateur retrouve ses
/// sonneries a l'identique d'un appareil a l'autre, et « a l'identique » inclut
/// leur ordre dans le selecteur.
///
/// `id` en second rang parce que `created_at` seul n'est pas un ordre TOTAL :
/// deux imports tombes dans la meme milliseconde se departageraient au hasard,
/// et deux lectures successives pourraient les rendre en sens inverse.
const ORDRE_SONNERIES: Prisma.UserRingtoneOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

export function jsonSonnerie(sonnerie: LigneSonnerie): SonnerieJson {
  return {
    id: sonnerie.id,
    url: sonnerie.url,
    label: sonnerie.label,
    createdAt: sonnerie.createdAt.toISOString(),
  };
}

/// Le catalogue de l'appelant, dans l'ordre du contrat.
export async function catalogueDe(userId: string) {
  return prisma.userRingtone.findMany({
    // Le `where` sur userId n'est pas qu'un filtre d'affichage : un catalogue
    // n'appartient qu'a son compte et ne doit jamais fuir vers un autre.
    where: { userId },
    orderBy: ORDRE_SONNERIES,
  });
}
