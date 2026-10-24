import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { auteurId, routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { adressePublique, isAllowedMime, saveBuffer } from "@/modules/media/storage";

/**
 * POST /api/upload/media — un fichier déposé par la console (formulaire,
 * champ `file`) : image ou vidéo de la bienvenue, d'un statut de bienvenue ou
 * d'une diffusion, photo de profil de l'administrateur.
 *
 * Même réponse que chez Alanya2026 : `{ url, filename, originalName,
 * mimetype, size }`. `url` est l'adresse fixe du bucket ouvert quand il est
 * configuré, sinon la route publique `GET /api/upload/media/:id`.
 */
const TYPES = /^(image|video|audio)\//;
const TAILLE_MAX = 100 * 1024 * 1024;

export const POST = routeAdmin("profile.update", async (req, session) => {
  const formulaire = await req.formData().catch(() => null);
  const fichier = formulaire?.get("file");
  if (!(fichier instanceof File)) throw new ErreurAdmin(400, "Aucun fichier reçu", "FILE_REQUIRED");
  const mime = fichier.type || "application/octet-stream";
  if (!isAllowedMime(mime) || !TYPES.test(mime)) {
    throw new ErreurAdmin(400, "Seules les images, vidéos et sons sont acceptés", "UNSUPPORTED_TYPE");
  }
  if (fichier.size > TAILLE_MAX) throw new ErreurAdmin(413, "Fichier trop volumineux (100 Mo au plus)", "FILE_TOO_LARGE");

  const octets = Buffer.from(await fichier.arrayBuffer());
  const { storedName, relativeUrl, espace } = await saveBuffer(octets, fichier.name || "media", mime, "public");
  const media = await prisma.mediaFile.create({
    data: {
      ownerId: session.userId,
      filename: fichier.name || storedName,
      mimeType: mime,
      sizeBytes: octets.length,
      url: relativeUrl,
      espace: espace === "public" ? "public" : null,
    },
  });
  await prisma.gestionMedia.create({ data: { mediaId: media.id, creePar: auteurId(session) } });

  return okAdmin({
    url: adressePublique(relativeUrl, media.espace) ?? `${env.publicBaseUrl}/api/upload/media/${media.id}`,
    filename: storedName,
    originalName: fichier.name,
    mimetype: mime,
    size: octets.length,
  });
});
