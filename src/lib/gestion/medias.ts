import { prisma } from "@/lib/prisma";

/**
 * Les médias de la console (bienvenue, statuts, diffusions) une fois envoyés.
 *
 * L'éditeur ne connaît que l'URL rendue par `POST /api/upload/media` ; on
 * retrouve le fichier par elle, et seulement parmi ceux que la console a
 * déposés (`gestion_media`) — une URL quelconque ne désigne rien.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Le fichier de la console désigné par cette URL, ou `null`. */
export async function mediaDeConsole(url: string | null | undefined) {
  if (!url) return null;
  // Forme `…/api/upload/media/<id>` : l'identifiant est dans l'URL.
  const parId = url.match(/\/api\/upload\/media\/([0-9a-f-]{36})/i)?.[1];
  if (parId && UUID.test(parId)) {
    const marque = await prisma.gestionMedia.findUnique({ where: { mediaId: parId } });
    return marque ? prisma.mediaFile.findUnique({ where: { id: parId } }) : null;
  }
  // Forme bucket ouvert `…/<jour>/<nom stocké>` : le chemin relatif termine l'URL.
  const chemin = url.split("?")[0].split("/").slice(-2).join("/");
  if (!chemin.includes("/")) return null;
  const media = await prisma.mediaFile.findFirst({ where: { url: chemin } });
  if (!media) return null;
  const marque = await prisma.gestionMedia.findUnique({ where: { mediaId: media.id } });
  return marque ? media : null;
}

/**
 * Une nouvelle ligne `media_files` pour le MÊME fichier stocké, possédée par
 * `proprietaireId`. Chaque message a la sienne (`messageId` est unique par
 * ligne) ; le binaire, lui, n'est ni recopié ni renvoyé.
 */
export async function copieDuMedia(
  media: { filename: string; mimeType: string; sizeBytes: number; url: string; thumbnailUrl: string | null; durationMs: number | null; espace: string | null },
  proprietaireId: string,
) {
  return prisma.mediaFile.create({
    data: {
      ownerId: proprietaireId,
      filename: media.filename,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl,
      durationMs: media.durationMs,
      espace: media.espace,
    },
  });
}
