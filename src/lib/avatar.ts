import { env } from "@/lib/env";

/// Ancienne forme stockée : un chemin relatif à notre serveur.
const PREFIXE_LEGACY = "/api/media/";
/// Forme publique, servie sans jeton.
const CHEMIN_PUBLIC = "/api/avatars/";

/**
 * URL absolue et publique d'un avatar, à partir de l'identifiant du média.
 */
export function urlAvatar(idMedia: string): string {
  return `${env.publicBaseUrl}${CHEMIN_PUBLIC}${idMedia}`;
}

/**
 * Forme à ÉCRIRE en base. Appelée sur tout ce que le client envoie.
 *
 * ⚠️ Décision du 06/08/2026 : la base stocke désormais des URL ABSOLUES.
 *
 * C'est l'inverse du principe habituel — on préfère d'ordinaire garder une
 * identité et bâtir l'emplacement à la lecture. Ce qui tranche ici, c'est que
 * **la base est PARTAGÉE** : le backend de l'équipe lit `users.avatar_url`
 * directement, sans passer par notre API. Un chemin relatif n'a de sens que
 * pour qui connaît notre hôte ; il était donc inutilisable pour eux.
 *
 * Le prix à payer, assumé : un changement de domaine deviendra une migration
 * de données, là où une variable d'environnement suffisait. Le jour venu, un
 * seul UPDATE sur deux colonnes — c'est le coût de rendre la donnée lisible
 * par tous.
 */
export function avatarStockage(entree: string | null | undefined): string | null {
  const valeur = entree?.trim();
  if (!valeur) return null;

  if (valeur.startsWith(PREFIXE_LEGACY)) {
    const id = valeur.slice(PREFIXE_LEGACY.length);
    if (!id || id.includes("/")) return null;
    return urlAvatar(id);
  }

  // Déjà absolue, ou `data:` écrite par l'application de l'équipe : intacte.
  return valeur;
}

/**
 * Forme à RENVOYER aux clients.
 *
 * Depuis que la base stocke de l'absolu, c'est presque toujours l'identité.
 * La conversion reste là pour les lignes qu'aucune écriture n'a encore
 * touchées : la migration couvre l'existant, mais une base restaurée d'une
 * vieille sauvegarde repasserait par ici.
 */
export function avatarPublicUrl(stocke: string | null | undefined): string | null {
  return avatarStockage(stocke);
}

/**
 * Les formes sous lesquelles un avatar peut être référencé en base pour un
 * média donné.
 *
 * Sert aux contrôles d'accès : `/api/avatars/<id>` et `/api/media/<id>` ne
 * servent un fichier que s'il est RÉELLEMENT référencé comme avatar. Ces
 * contrôles comparaient une chaîne exacte ; avec deux formes en circulation
 * pendant la transition, un seul motif aurait renvoyé 404 sur la moitié du
 * parc.
 */
export function formesStockeesPour(idMedia: string): string[] {
  return [urlAvatar(idMedia), `${PREFIXE_LEGACY}${idMedia}`];
}
