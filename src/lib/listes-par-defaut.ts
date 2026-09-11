import { prisma } from "./prisma";

/**
 * LES QUATRE LISTES QUE TOUT LE MONDE A DÈS LE DÉPART.
 *
 * Une liste de contacts vide ne se remplit jamais : il faut d'abord comprendre
 * à quoi elle sert, puis en inventer une, puis la nommer. Quatre listes déjà
 * là — famille, bureau, confiance, amis — répondent à la question avant qu'elle
 * se pose, et il ne reste qu'à y glisser des gens.
 *
 * 🔴 ELLES SE MODIFIENT MAIS NE SE SUPPRIMENT PAS (décision du 08/09/2026).
 *
 * Le choix précédent était l'inverse : aucune marque en base, donc suppression
 * libre — pour que celui qui n'en veut pas ne les voie pas revenir à chaque
 * connexion. La demande a changé : ces quatre listes doivent être présentes chez
 * TOUT LE MONDE. Nom, couleur, sonnerie et membres restent librement
 * modifiables ; seule la suppression est refusée, et c'est `cle` qui permet au
 * serveur de savoir laquelle protéger.
 *
 * Les sonneries sont des noms de fichiers LIVRÉS AVEC LES CLIENTS, pas des
 * médias téléversés : le champ accepte les deux formes, et poser quatre fichiers
 * identiques par utilisateur remplirait le stockage pour rien.
 */
export const LISTES_PAR_DEFAUT = [
  { cle: "bureau", name: "Bureau", color: "#1e88e5", ringtone: "liste-bureau.mp3" },
  { cle: "amis", name: "Amis", color: "#43a047", ringtone: "liste-amis.mp3" },
  { cle: "confiance", name: "Confiance", color: "#8e24aa", ringtone: "liste-confiance.mp3" },
  { cle: "famille", name: "Famille", color: "#e53935", ringtone: "liste-famille.mp3" },
] as const;

/**
 * Crée celles des quatre listes qui manquent à ce compte.
 *
 * ⚠️ SÛR À RÉPÉTER, et c'est ce qu'on lui demande : cette fonction est appelée à
 * CHAQUE lecture des listes (`GET /api/contact-lists`). L'idempotence vient de la
 * clé — une liste déjà présente sous sa clé n'est pas recréée, même renommée.
 *
 * On ne peut plus « supprimer Bureau pour de bon » : c'est précisément ce que la
 * décision du 08/09/2026 a changé, et le serveur refuse désormais cette
 * suppression au lieu de laisser la liste réapparaître sans explication.
 *
 * Ne lève jamais : un compte sans ses listes par défaut reste parfaitement
 * utilisable, alors qu'une erreur ici bloquerait l'écran des contacts.
 */
export async function creerListesParDefaut(userId: string): Promise<void> {
  try {
    /*
     * 🐛 ON NE TESTE PLUS « LE COMPTE N'A AUCUNE LISTE », et c'était le défaut.
     *
     * Cette condition voulait dire : on ne sème qu'aux comptes neufs. Or tout
     * compte existant avait déjà au moins une liste à lui — il n'a donc JAMAIS
     * reçu les quatre, et son propriétaire ne comprenait pas pourquoi elles
     * n'apparaissaient pas. On sème maintenant CLÉ PAR CLÉ : l'appel devient
     * rejouable, et les comptes anciens sont rattrapés à leur première ouverture
     * de l'écran des contacts.
     */
    const existantes = await prisma.contactList.findMany({
      where: { userId },
      select: { cle: true, name: true },
    });
    const clesPrises = new Set(existantes.map((l) => l.cle).filter(Boolean));
    const nomsPris = new Set(existantes.map((l) => l.name));

    const aCreer = LISTES_PAR_DEFAUT.filter((l) => {
      if (clesPrises.has(l.cle)) return false;
      /*
       * ⚠️ UN NOM DÉJÀ PRIS FAIT RENONCER, plutôt que d'adopter la liste
       * existante ou d'en créer une seconde.
       *
       * Adopter la liste « Amis » que l'utilisateur a faite lui-même la rendrait
       * NON SUPPRIMABLE sans qu'il l'ait demandé. En créer une seconde du même
       * nom violerait l'unicité (utilisateur, nom) et ferait échouer tout le
       * lot. Renoncer ne retire rien à personne.
       */
      if (nomsPris.has(l.name)) return false;
      return true;
    });
    if (aCreer.length === 0) return;

    await prisma.contactList.createMany({
      data: aCreer.map((l) => ({
        userId,
        cle: l.cle,
        name: l.name,
        color: l.color,
        ringtone: l.ringtone,
      })),
      // Deux appareils ouvrant l'écran au même instant passeraient tous deux le
      // test ci-dessus ; le second échouerait sur l'unicité (compte, clé).
      skipDuplicates: true,
    });
  } catch (e) {
    console.error("[listes] création des listes par défaut ignorée :", e);
  }
}
