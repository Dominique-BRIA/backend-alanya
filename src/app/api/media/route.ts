import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isAllowedMime, saveBuffer } from "@/modules/media/storage";

// POST /api/media — upload d'un fichier (multipart/form-data, champ "file").
// Le binaire est stocké sur disque ; seules les métadonnées vont en base.
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
  const { relativeUrl } = await saveBuffer(buffer, file.name, file.type);

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
      url: `/api/media/${media.id}`,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      durationMs: media.durationMs,
    },
    201,
  );
});
