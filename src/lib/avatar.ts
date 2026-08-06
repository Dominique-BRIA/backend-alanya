import { env } from "@/lib/env";

/// Préfixe canonique stocké en base pour un avatar hébergé chez nous.
/// La base garde une IDENTITÉ, jamais un emplacement : c'est ce qui permet de
/// changer de domaine ou de serveur de fichiers sans toucher aux données.
const PREFIXE_MEDIA = "/api/media/";

/**
 * Transforme la valeur brute de `users.avatar_url` en URL utilisable telle
 * quelle par n'importe quel client.
 *
 * Le but est qu'il n'y ait plus AUCUNE règle côté client — ni concaténation,
 * ni test `startsWith("http")`, ni jeton à joindre. Chaque frontend affiche la
 * chaîne reçue. C'est aussi ce qui rend les avatars lisibles par l'application
 * de l'équipe, qui n'a pas nos jetons.
 *
 * Trois formes coexistent en base, et cette fonction est le seul endroit qui le
 * sait :
 *
 *   `/api/media/<id>`   notre forme → devient une URL absolue et PUBLIQUE
 *   `data:image/...`    écrite par l'application de l'équipe → telle quelle
 *   `https://...`       avatars générés → telle quelle
 *
 * ⚠️ On pointe vers `/api/avatars/<id>`, pas vers `/api/media/<id>`. Cette
 * seconde route sert aussi les pièces jointes privées des conversations :
 * l'ouvrir sans jeton exposerait tout. La route dédiée ne sert QUE ce qui est
 * effectivement référencé comme avatar.
 */
export function avatarPublicUrl(stocke: string | null | undefined): string | null {
  const valeur = stocke?.trim();
  if (!valeur) return null;

  if (valeur.startsWith(PREFIXE_MEDIA)) {
    const id = valeur.slice(PREFIXE_MEDIA.length);
    // Un identifiant vide ou contenant un chemin ne doit pas produire d'URL :
    // mieux vaut pas d'avatar qu'une URL fabriquée à partir d'une donnée douteuse.
    if (!id || id.includes("/")) return null;
    return `${env.publicBaseUrl}/api/avatars/${id}`;
  }

  // `data:` et `http(s)://` sont déjà affichables partout : on ne touche pas.
  // Toute autre forme est laissée telle quelle plutôt que jetée — la colonne
  // est alimentée par une autre application, et un format inconnu doit rester
  // visible côté client plutôt que disparaître silencieusement.
  return valeur;
}
