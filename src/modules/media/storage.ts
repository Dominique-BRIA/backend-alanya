import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { uploadToB2, getB2SignedUrl, readFromB2, deleteFromB2 } from "./b2";

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

export function isAllowedMime(mime: string): boolean {
  // Accepte aussi tout texte (text/*) et le générique ci-dessus.
  return ALLOWED_MIME.has(mime) || mime.startsWith("text/");
}

function extensionFor(filename: string, mime: string): string {
  const ext = path.extname(filename);
  if (ext) return ext;
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
export async function saveBuffer(
  buffer: Buffer,
  originalName: string,
  mime: string,
): Promise<{ storedName: string; relativeUrl: string }> {
  // En serverless sans B2 configuré, on échoue tôt et clairement (cf. assertStorageUsable).
  assertStorageUsable();

  const { storedName, relativeUrl } = buildRelativeUrl(originalName, mime);

  if (useCloudStorage()) {
    await uploadToB2(buffer, relativeUrl, { contentType: mime });
  } else {
    const dir = path.join(storageRoot(), relativeUrl.slice(0, 10));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(storageRoot(), relativeUrl), buffer);
  }

  return { storedName, relativeUrl };
}

// Lit le binaire (disque OU B2). En mode B2, préférez getSignedDownloadUrl +
// redirection 302 plutôt que de tout charger en mémoire (cf. route GET /api/media/:id).
export async function readStored(relativeUrl: string): Promise<Buffer> {
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
export async function deleteStored(relativeUrl: string): Promise<void> {
  try {
    if (useCloudStorage()) {
      await deleteFromB2(relativeUrl);
    } else {
      await fs.unlink(path.join(storageRoot(), relativeUrl));
    }
  } catch {
    /* best-effort : fichier déjà absent ou inaccessible */
  }
}
