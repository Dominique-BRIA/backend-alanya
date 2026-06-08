import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "@/lib/env";

// Répertoire absolu de stockage des binaires (hors base de données).
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

// Écrit le binaire sur le disque et renvoie le nom de fichier stocké + le chemin relatif.
export async function saveBuffer(
  buffer: Buffer,
  originalName: string,
  mime: string,
): Promise<{ storedName: string; relativeUrl: string }> {
  const root = storageRoot();
  // Répartition par jour pour éviter trop de fichiers dans un seul dossier.
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, day);
  await fs.mkdir(dir, { recursive: true });

  const storedName = `${crypto.randomUUID()}${extensionFor(originalName, mime)}`;
  await fs.writeFile(path.join(dir, storedName), buffer);

  // URL d'accès servie par /api/media/:id (l'id est en base).
  return { storedName, relativeUrl: `${day}/${storedName}` };
}

export async function readStored(relativeUrl: string): Promise<Buffer> {
  // Empêche toute traversée de répertoire.
  const safe = path.normalize(relativeUrl).replace(/^(\.\.(\/|\\|$))+/, "");
  return fs.readFile(path.join(storageRoot(), safe));
}
