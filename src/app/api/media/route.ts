import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail, HttpError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isAllowedMime, saveBuffer } from "@/modules/media/storage";

// POST /api/media — upload d'un fichier (multipart/form-data, champ "file").
// Le binaire est stocké sur disque (local) OU dans Backblaze B2 (cloud) selon
// MEDIA_STORAGE_PROVIDER ; seules les métadonnées vont en base.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Champ 'file' manquant", 400, "NO_FILE");

  if (!isAllowedMime(file.type)) {
    return fail(`Type de fichier non autorisé : ${file.type}`, 415, "BAD_MIME");
  }
  const maxBytes = env.media.maxSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return fail(`Fichier trop volumineux (max ${env.media.maxSizeMb} Mo)`, 413, "TOO_LARGE");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Téléversement (local ou B2). On isole l'erreur de stockage pour renvoyer un
  // code explicite plutôt qu'un 400 générique — un échec B2 n'est pas une
  // mauvaise requête du client.
  const { relativeUrl } = await saveBuffer(buffer, file.name, file.type).catch((err) => {
    console.error("[media] Échec d'upload du stockage :", err);
    throw new HttpError(502, "Échec du téléversement du fichier", "STORAGE_ERROR");
  });

  // Durée éventuelle (audio/vidéo) fournie par le client.
  const durationRaw = form.get("durationMs");
  const durationMs = durationRaw ? Number(durationRaw) : null;

  const media = await prisma.mediaFile.create({
    data: {
      ownerId: userId,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      url: relativeUrl,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
    },
  });

  return ok(
    {
      id: media.id,
      // L'URL d'accès reste proxyfiée par le backend : cela garantit le contrôle
      // d'accès (owner/participant) quel que soit le backend de stockage.
      url: `/api/media/${media.id}`,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      durationMs: media.durationMs,
    },
    201,
  );
});
