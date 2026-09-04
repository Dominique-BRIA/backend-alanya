import { prisma } from "./prisma";

/**
 * LES QUATRE LISTES QUE TOUT LE MONDE A DÈS LE DÉPART.
 *
 * Une liste de contacts vide ne se remplit jamais : il faut d'abord comprendre
 * à quoi elle sert, puis en inventer une, puis la nommer. Quatre listes déjà
 * là — famille, bureau, confiance, amis — répondent à la question avant qu'elle
 * se pose, et il ne reste qu'à y glisser des gens.
 *
 * ⚠️ CE NE SONT PAS DES LISTES SPÉCIALES. Une fois créées, elles se renomment,
 * se recolorent et se suppriment comme les autres. Aucun drapeau ne les
 * distingue en base — les marquer aurait demandé une colonne, et surtout aurait
 * empêché de les supprimer pour de bon : celui qui n'en veut pas les verrait
 * revenir à chaque connexion.
 *
 * Les sonneries sont des noms de fichiers LIVRÉS AVEC LES CLIENTS, pas des
 * médias téléversés : le champ accepte les deux formes, et poser quatre fichiers
 * identiques par utilisateur remplirait le stockage pour rien.
 */
export const LISTES_PAR_DEFAUT = [
  { name: "Bureau", color: "#1e88e5", ringtone: "liste-bureau.mp3" },
  { name: "Amis", color: "#43a047", ringtone: "liste-amis.mp3" },
  { name: "Confiance", color: "#8e24aa", ringtone: "liste-confiance.mp3" },
  { name: "Famille", color: "#e53935", ringtone: "liste-famille.mp3" },
] as const;

/**
 * Crée les quatre listes pour un compte qui n'en a aucune.
 *
 * ⚠️ SEULEMENT SI LE COMPTE N'EN A AUCUNE, et c'est ce qui rend l'appel sûr à
 * répéter. Sans cette condition, quelqu'un qui a supprimé « Bureau » la verrait
 * réapparaître à sa prochaine connexion — et n'aurait aucun moyen de s'en
 * débarrasser.
 *
 * `createMany` avec `skipDuplicates` en plus : deux appareils qui se connectent
 * au même instant passeraient tous deux le test « aucune liste », et le second
 * échouerait sur la contrainte d'unicité (utilisateur, nom).
 *
 * Ne lève jamais : un compte sans ses listes par défaut reste parfaitement
 * utilisable, alors qu'une erreur ici bloquerait l'écran des contacts.
 */
export async function creerListesParDefaut(userId: string): Promise<void> {
  try {
    const dejaLa = await prisma.contactList.count({ where: { userId } });
    if (dejaLa > 0) return;

    await prisma.contactList.createMany({
      data: LISTES_PAR_DEFAUT.map((l) => ({
        userId,
        name: l.name,
        color: l.color,
        ringtone: l.ringtone,
      })),
      skipDuplicates: true,
    });
  } catch (e) {
    console.error("[listes] création des listes par défaut ignorée :", e);
  }
}
