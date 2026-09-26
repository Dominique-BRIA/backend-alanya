import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { uploadToB2, getB2SignedUrl, readFromB2, deleteFromB2 } from "./b2";
import {
  deleteFromB2Public,
  publicConfigure,
  publicUrl,
  readFromB2Public,
  uploadToB2Public,
} from "./b2-public";

// =============================================================================
// Couche de stockage des médias — abstraction provider.
// =============================================================================
// Deux backends possibles, choisis via MEDIA_STORAGE_PROVIDER :
//   - "local" : système de fichiers (comportement historique, défaut)
//   - "b2"    : Backblaze B2 (stockage objet cloud, via l'API S3)
//
// La signature publique (saveBuffer / readStored) est inchangée : les routes
// n'ont pas à se soucier du backend sous-jacent.
// =============================================================================

// Sélection du backend actif.
export function useCloudStorage(): boolean {
  return env.media.provider === "b2" && env.media.b2.isConfigured();
}

// Détecte les environnements serverless à système de fichiers en lecture seule
// (Vercel, AWS Lambda...). Sur ces plateformes, écrire dans le répertoire du
// code déployé (/var/task/...) est impossible → d'où le fameux ENOENT/EROFS.
function isServerlessReadOnly(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

// Garde-fou : en serverless, le stockage local est inutilisable. On échoue
// TÔT avec un message explicite plutôt que d'attendre un "ENOENT mkdir" cryptique.
// → indique clairement qu'il faut définir MEDIA_STORAGE_PROVIDER=b2 (+ clés B2)
//   dans le dashboard de l'hébergeur (Vercel), car le fichier .env n'y est pas lu.
export function assertStorageUsable(): void {
  if (isServerlessReadOnly() && !useCloudStorage()) {
    throw new HttpError(
      500,
      "Stockage local indisponible en serverless (FS en lecture seule). "
        + "Définis MEDIA_STORAGE_PROVIDER=b2 ainsi que B2_KEY_ID et B2_APPLICATION_KEY "
        + "dans le dashboard Vercel (le fichier .env local n'est PAS utilisé en production).",
      "STORAGE_MISCONFIGURED",
    );
  }
}

// Répertoire absolu de stockage des binaires en mode local (hors base de données).
export function storageRoot(): string {
  return path.isAbsolute(env.media.storageDir)
    ? env.media.storageDir
    : path.join(process.cwd(), env.media.storageDir);
}

// Extensions/MIME autorisés (images, audio des messages vocaux, vidéos, documents).
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // Formats iPhone récents (photos par défaut sur iOS 11+).
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  // Type générique (fichiers divers)
  "application/octet-stream",
]);

/**
 * Le TYPE seul, sans ses paramètres — « audio/webm;codecs=opus » → « audio/webm ».
 *
 * 🐛 DEUXIÈME OCCURRENCE DU MÊME DÉFAUT, et c'est ce qui justifie de le traiter
 * ici plutôt que chez l'appelant.
 *
 *   - 20/08/2026 : l'enregistrement d'appel du web échouait en 415 (Firefox,
 *     4 essais). Corrigé côté CLIENT (`enregistrement-appel.ts`), qui n'envoie
 *     plus que le conteneur.
 *   - 25/08/2026 : la PLAINTE VOCALE du web échoue pareil — « ce type de
 *     fichier n'est pas pris en compte ». Le second enregistreur du même dépôt
 *     n'avait pas reçu le correctif du premier.
 *
 * Corriger le client une fois de plus laisserait le troisième enregistreur
 * tomber dans le même trou. Un paramètre de type de média est PRÉVU par la
 * norme (RFC 9110 §8.3) : c'est la liste blanche qui avait tort de comparer la
 * chaîne entière, pas les navigateurs de l'émettre.
 *
 * ⚠️ Le mobile n'a jamais été touché : il produit « audio/mp4 » ou
 * « audio/aac », sans paramètre — d'où « sur le mobile ça passe bien ».
 */
function typeSansParametre(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function isAllowedMime(mime: string): boolean {
  // Accepte aussi tout texte (text/*) et le générique ci-dessus.
  const type = typeSansParametre(mime);
  return ALLOWED_MIME.has(type) || type.startsWith("text/");
}

function extensionFor(filename: string, mime: string): string {
  const ext = path.extname(filename);
  if (ext) return ext;
  // Même normalisation que la liste blanche : sans elle, un fichier sans
  // extension nommé par un navigateur repartait sans extension du tout, la
  // table ci-dessous ne connaissant pas les types paramétrés.
  mime = typeSansParametre(mime);
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? "";
}

// Génère la "clé" canonique d'un média : <YYYY-MM-DD>/<uuid><ext>.
// Cette clé est stockée en base (MediaFile.url) et sert d'identifiant d'objet,
// quel que soit le backend (locale = chemin relatif, B2 = clé objet).
export function buildRelativeUrl(originalName: string, mime: string): {
  storedName: string;
  relativeUrl: string;
} {
  const day = new Date().toISOString().slice(0, 10);
  const storedName = `${crypto.randomUUID()}${extensionFor(originalName, mime)}`;
  return { storedName, relativeUrl: `${day}/${storedName}` };
}

// Persiste le binaire (disque OU B2) et renvoie la clé canonique stockée.
/**
 * `espace` dit OÙ ranger, et il n'a que deux valeurs.
 *
 * ⚠️ « public » NE VEUT PAS DIRE « moins important » : il veut dire « lu par
 * n'importe qui, sans compte ». N'y envoyer QUE ce qui est de toute façon
 * entendu par tous les appelants — l'accueil qu'on enregistre, la sonnerie
 * qu'on choisit. Jamais un message laissé PAR quelqu'un.
 */
export type EspaceStockage = "prive" | "public";

export async function saveBuffer(
  buffer: Buffer,
  originalName: string,
  mime: string,
  espace: EspaceStockage = "prive",
): Promise<{ storedName: string; relativeUrl: string; espace: EspaceStockage }> {
  // En serverless sans B2 configuré, on échoue tôt et clairement (cf. assertStorageUsable).
  assertStorageUsable();

  const { storedName, relativeUrl } = buildRelativeUrl(originalName, mime);

  /*
   * ⚠️ LE BUCKET PUBLIC EXIGE D'ÊTRE CONFIGURÉ, sinon on retombe dans le privé
   * SANS ÉCHOUER. Un accueil servi par URL signée reste parfaitement
   * fonctionnel — seulement un peu plus lent. Refuser l'envoi rendrait le
   * répondeur inutilisable pour une optimisation absente, ce qui serait
   * l'inverse de ce qu'on cherche.
   */
  if (espace === "public" && publicConfigure()) {
    await uploadToB2Public(relativeUrl, buffer, mime);
    return { storedName, relativeUrl, espace: "public" };
  }

  if (useCloudStorage()) {
    await uploadToB2(buffer, relativeUrl, { contentType: mime });
  } else {
    const dir = path.join(storageRoot(), relativeUrl.slice(0, 10));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(storageRoot(), relativeUrl), buffer);
  }

  return { storedName, relativeUrl, espace: "prive" };
}

/**
 * L'adresse FIXE d'un média public, ou `null` s'il n'en a pas.
 *
 * 🔴 C'EST TOUT L'INTÉRÊT DU BUCKET OUVERT. Elle ne change pas, ne porte aucun
 * jeton, n'expire jamais : le navigateur la met en cache, et un accueil déjà
 * entendu ne se retélécharge pas. Une URL signée change à chaque demande — le
 * cache ne peut rien en faire.
 */
export function adressePublique(relativeUrl: string, espace: string | null): string | null {
  // La condition « bucket configuré » vit dans `adresseOuverte`, en un seul
  // endroit. La redoubler ici donnerait deux vérités, et la plus ancienne
  // finirait par mentir.
  if (espace !== "public") return null;
  return publicUrl(relativeUrl);
}

/**
 * Lit le binaire (disque, bucket privé OU bucket ouvert).
 *
 * En mode B2, préférez `getSignedDownloadUrl` + redirection 302 plutôt que de
 * tout charger en mémoire (cf. route GET /api/media/:id).
 *
 * ⚠️ `espace` N'EST PAS DÉCORATIF. Un fichier du bucket ouvert cherché dans le
 * bucket privé n'y est PAS : la lecture échoue, la route rend 410 « fichier
 * manquant », et l'on part chercher un fichier perdu qui est là où il doit
 * être. Le paramètre est optionnel pour que les appelants qui ne manipulent que
 * du privé restent inchangés — mais tout appelant qui a l'espace sous la main
 * doit le passer.
 */
export async function readStored(
  relativeUrl: string,
  espace: string | null = null,
): Promise<Buffer> {
  if (espace === "public" && publicConfigure()) {
    return readFromB2Public(relativeUrl);
  }
  if (useCloudStorage()) {
    return readFromB2(relativeUrl);
  }
  // Empêche toute traversée de répertoire.
  const safe = path.normalize(relativeUrl).replace(/^(\.\.(\/|\\|$))+/, "");
  return fs.readFile(path.join(storageRoot(), safe));
}

// URL présignée d'accès à un objet privé (B2 uniquement).
// Renvoie null en mode local (le fichier est servi directement par le backend).
export async function getSignedDownloadUrl(
  relativeUrl: string,
  opts?: { expiresInSec?: number; responseContentDisposition?: string },
): Promise<string | null> {
  if (!useCloudStorage()) return null;
  return getB2SignedUrl(relativeUrl, opts);
}

// Supprime le binaire (disque OU B2) — best-effort, n'échoue jamais
// (un fichier déjà absent ne doit pas casser la suppression du média en base).
export async function deleteStored(
  relativeUrl: string,
  espace: string | null = null,
): Promise<void> {
  try {
    // ⚠️ SUPPRIMER AU BON ENDROIT. Un média public effacé dans le bucket privé
    // ne disparaîtrait de nulle part, et resterait lisible de tout Internet —
    // le pire des deux mondes.
    if (espace === "public" && publicConfigure()) {
      await deleteFromB2Public(relativeUrl);
    } else if (useCloudStorage()) {
      await deleteFromB2(relativeUrl);
    } else {
      await fs.unlink(path.join(storageRoot(), relativeUrl));
    }
  } catch {
    /* best-effort : fichier déjà absent ou inaccessible */
  }
}
