import { crc32, deflateRawSync } from "node:zlib";

/**
 * UNE ARCHIVE ZIP ÉCRITE AU FIL DE L'EAU.
 *
 * 🔴 ÉCRITE À LA MAIN, ET C'EST UN CHOIX. Les bibliothèques d'archivage du
 * marché construisent l'archive en mémoire ou dans un fichier temporaire avant
 * de la servir : pour un export de plusieurs gigaoctets, cela veut dire
 * plusieurs gigaoctets de mémoire, ou un disque qui se remplit à chaque export
 * simultané. Ici, chaque fichier est lu, écrit, puis oublié — la mémoire ne
 * dépend PAS de la taille de l'archive. C'est ce qui permet d'exporter un an de
 * conversations sur un serveur partagé par des milliers de comptes.
 *
 * Le format ZIP est resté volontairement simple sur ce point : on peut écrire
 * les entrées les unes après les autres, et ne poser l'index qu'à la fin.
 *
 * ⚠️ AUCUNE DÉPENDANCE AJOUTÉE. `crc32` et `deflateRawSync` viennent de Node.
 * Une dépendance de plus, c'est une surface d'attaque de plus et une mise à jour
 * de plus à suivre, pour un format dont la partie utile tient en cent lignes.
 */

/** Un fichier à placer dans l'archive. */
export interface EntreeArchive {
  /** Chemin DANS l'archive, séparateurs `/`. */
  chemin: string;
  donnees: Buffer;
  /** Date affichée par les logiciels d'archivage. */
  date: Date;
  /** Type MIME, qui décide s'il vaut la peine de compresser. */
  mime: string;
}

/**
 * Faut-il compresser ce contenu ?
 *
 * 🔴 NON, POUR LA QUASI-TOTALITÉ DES MÉDIAS — et c'est la décision qui fait la
 * différence à grande échelle. Une photo JPEG, une vidéo MP4, un vocal Opus, un
 * PDF, un `.docx` sont DÉJÀ COMPRESSÉS. Les repasser dans `deflate` coûte du
 * processeur sur chaque octet pour gagner un à deux pour cent — parfois pour en
 * PERDRE, l'algorithme ajoutant son propre en-tête à des données incompressibles.
 *
 * Sur un export d'un gigaoctet, c'est une seconde de processeur contre trente.
 * Multiplié par le nombre d'exports simultanés, c'est la différence entre un
 * serveur calme et un serveur à genoux.
 *
 * On ne compresse donc que ce qui y gagne vraiment : le texte.
 */
function vautLaCompression(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/rtf" ||
    m === "image/svg+xml" ||
    m.endsWith("+json") ||
    m.endsWith("+xml")
  );
}

/** Méthode ZIP : 0 = stocké tel quel, 8 = deflate. */
const STOCKE = 0;
const DEFLATE = 8;

/** Au-delà, le format d'origine ne sait plus compter : il faut Zip64. */
const LIMITE_32_BITS = 0xffffffff;

/**
 * L'horodatage au format MS-DOS, qui est celui du ZIP depuis 1989.
 *
 * ⚠️ IL NE SAIT PAS DESCENDRE SOUS DEUX SECONDES, et ne connaît aucun fuseau :
 * c'est une limite du format, pas un oubli. On y écrit donc l'heure LOCALE du
 * serveur, ce que font tous les logiciels d'archivage — l'heure exacte reste
 * dans le nom du fichier, qui, lui, ne ment pas.
 */
function horodatageDos(date: Date): { heure: number; jour: number } {
  const annee = Math.max(1980, date.getFullYear());
  return {
    heure:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    jour: ((annee - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Une entrée déjà écrite, retenue pour l'index de fin d'archive. */
interface EntreeIndex {
  nom: Buffer;
  methode: number;
  heure: number;
  jour: number;
  crc: number;
  tailleCompressee: number;
  tailleReelle: number;
  decalage: number;
}

/**
 * Les octets de l'archive, produits au fur et à mesure.
 *
 * ⚠️ UN GÉNÉRATEUR, ET NON UN TABLEAU QUI GROSSIT : c'est ce qui fait que la
 * mémoire reste constante. Chaque morceau part vers le réseau dès qu'il est
 * prêt, et le fichier suivant n'est lu que lorsque le précédent est parti.
 */
async function* octetsDeLArchive(
  source: AsyncIterable<EntreeArchive>,
): AsyncGenerator<Uint8Array> {
  const index: EntreeIndex[] = [];
  let decalage = 0;

  for await (const entree of source) {
    const nom = Buffer.from(entree.chemin, "utf8");
    const { heure, jour } = horodatageDos(entree.date);
    const tailleReelle = entree.donnees.length;
    const crc = crc32(entree.donnees);

    const compresser = vautLaCompression(entree.mime);
    const corps = compresser ? deflateRawSync(entree.donnees) : entree.donnees;
    /*
     * ⚠️ ON REVIENT AU STOCKAGE SI LA COMPRESSION A FAIT GROSSIR. Cela arrive
     * sur des données déjà compactes, et livrer une entrée plus grosse que
     * l'original serait le contraire de ce qu'on cherche.
     */
    const gagnant = compresser && corps.length < tailleReelle;
    const donneesFinales = gagnant ? corps : entree.donnees;
    const methode = gagnant ? DEFLATE : STOCKE;

    // ── En-tête local ──────────────────────────────────────────────────
    const enTete = Buffer.alloc(30);
    enTete.writeUInt32LE(0x04034b50, 0); // signature
    enTete.writeUInt16LE(20, 4); // version minimale pour extraire
    // Bit 11 : le nom est en UTF-8. Sans lui, les accents et les noms non
    // latins ressortent en charabia sous Windows.
    enTete.writeUInt16LE(0x0800, 6);
    enTete.writeUInt16LE(methode, 8);
    enTete.writeUInt16LE(heure, 10);
    enTete.writeUInt16LE(jour, 12);
    enTete.writeUInt32LE(crc, 14);
    enTete.writeUInt32LE(donneesFinales.length, 18);
    enTete.writeUInt32LE(tailleReelle, 22);
    enTete.writeUInt16LE(nom.length, 26);
    enTete.writeUInt16LE(0, 28); // pas de champ supplémentaire

    index.push({
      nom,
      methode,
      heure,
      jour,
      crc,
      tailleCompressee: donneesFinales.length,
      tailleReelle,
      decalage,
    });

    yield enTete;
    yield nom;
    yield donneesFinales;
    decalage += enTete.length + nom.length + donneesFinales.length;
  }

  // ── L'index, à la fin ────────────────────────────────────────────────
  const debutIndex = decalage;
  let tailleIndex = 0;
  for (const e of index) {
    /*
     * ⚠️ ZIP64 SUR LE SEUL DÉCALAGE. Les fichiers eux-mêmes ne dépassent jamais
     * quatre gigaoctets — le téléversement est plafonné bien en dessous — mais
     * l'ARCHIVE ENTIÈRE, elle, le peut : un an de vidéos y arrive. Sans ce
     * champ, les entrées situées au-delà de la limite pointeraient n'importe où,
     * et l'archive s'ouvrirait « corrompue » alors qu'elle est complète.
     */
    const besoinZip64 = e.decalage >= LIMITE_32_BITS;
    const extra = besoinZip64 ? Buffer.alloc(12) : Buffer.alloc(0);
    if (besoinZip64) {
      extra.writeUInt16LE(0x0001, 0); // identifiant Zip64
      extra.writeUInt16LE(8, 2); // longueur des données qui suivent
      extra.writeBigUInt64LE(BigInt(e.decalage), 4);
    }

    const ligne = Buffer.alloc(46);
    ligne.writeUInt32LE(0x02014b50, 0);
    ligne.writeUInt16LE(besoinZip64 ? 45 : 20, 4); // version d'écriture
    ligne.writeUInt16LE(besoinZip64 ? 45 : 20, 6); // version minimale de lecture
    ligne.writeUInt16LE(0x0800, 8);
    ligne.writeUInt16LE(e.methode, 10);
    ligne.writeUInt16LE(e.heure, 12);
    ligne.writeUInt16LE(e.jour, 14);
    ligne.writeUInt32LE(e.crc, 16);
    ligne.writeUInt32LE(e.tailleCompressee, 20);
    ligne.writeUInt32LE(e.tailleReelle, 24);
    ligne.writeUInt16LE(e.nom.length, 28);
    ligne.writeUInt16LE(extra.length, 30);
    ligne.writeUInt16LE(0, 32); // pas de commentaire
    ligne.writeUInt16LE(0, 34); // disque 0
    ligne.writeUInt16LE(0, 36); // attributs internes
    ligne.writeUInt32LE(0, 38); // attributs externes
    ligne.writeUInt32LE(besoinZip64 ? LIMITE_32_BITS : e.decalage, 42);

    yield ligne;
    yield e.nom;
    if (extra.length > 0) yield extra;
    tailleIndex += ligne.length + e.nom.length + extra.length;
  }

  // ── La fin d'archive ─────────────────────────────────────────────────
  const zip64Requis =
    index.length >= 0xffff || debutIndex >= LIMITE_32_BITS || tailleIndex >= LIMITE_32_BITS;

  if (zip64Requis) {
    /*
     * Deux enregistrements de plus, posés AVANT la fin classique : un lecteur
     * ancien lit la fin classique et voit des valeurs saturées ; un lecteur
     * récent remonte au localisateur et trouve les vraies. Les deux savent
     * ouvrir l'archive — c'est tout l'intérêt de cette construction en couches.
     */
    const fin64 = Buffer.alloc(56);
    fin64.writeUInt32LE(0x06064b50, 0);
    fin64.writeBigUInt64LE(BigInt(44), 4); // taille de ce qui suit
    fin64.writeUInt16LE(45, 12);
    fin64.writeUInt16LE(45, 14);
    fin64.writeUInt32LE(0, 16); // ce disque
    fin64.writeUInt32LE(0, 20); // disque de l'index
    fin64.writeBigUInt64LE(BigInt(index.length), 24);
    fin64.writeBigUInt64LE(BigInt(index.length), 32);
    fin64.writeBigUInt64LE(BigInt(tailleIndex), 40);
    fin64.writeBigUInt64LE(BigInt(debutIndex), 48);
    yield fin64;

    const localisateur = Buffer.alloc(20);
    localisateur.writeUInt32LE(0x07064b50, 0);
    localisateur.writeUInt32LE(0, 4);
    localisateur.writeBigUInt64LE(BigInt(debutIndex + tailleIndex), 8);
    localisateur.writeUInt32LE(1, 16); // nombre total de disques
    yield localisateur;
  }

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(zip64Requis ? 0xffff : index.length, 8);
  fin.writeUInt16LE(zip64Requis ? 0xffff : index.length, 10);
  fin.writeUInt32LE(zip64Requis ? LIMITE_32_BITS : tailleIndex, 12);
  fin.writeUInt32LE(zip64Requis ? LIMITE_32_BITS : debutIndex, 16);
  fin.writeUInt16LE(0, 20); // pas de commentaire
  yield fin;
}

/**
 * L'archive, sous la forme que Next.js sait renvoyer directement.
 *
 * ⚠️ `pull` ET NON `start` : avec `start`, on produirait l'archive entière aussi
 * vite que possible, sans se soucier de ce que le réseau absorbe — et toute
 * l'archive s'accumulerait en mémoire devant un client lent. Avec `pull`, on ne
 * lit le fichier suivant que lorsque le précédent est parti. C'est la contre-
 * pression, et c'est elle qui tient la mémoire.
 */
export function fluxZip(source: AsyncIterable<EntreeArchive>): ReadableStream<Uint8Array> {
  const morceaux = octetsDeLArchive(source)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controleur) {
      try {
        const { value, done } = await morceaux.next();
        if (done) controleur.close();
        else controleur.enqueue(value);
      } catch (err) {
        // ⚠️ L'ARCHIVE S'INTERROMPT SANS SON INDEX : le téléchargement se
        // termine en erreur plutôt que de livrer un fichier qui s'ouvrirait en
        // paraissant complet. Une archive tronquée mais valide serait pire.
        controleur.error(err);
      }
    },
    cancel() {
      // Onglet fermé, téléchargement annulé : on arrête de lire le stockage.
      void morceaux.return?.(undefined);
    },
  });
}
