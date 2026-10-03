import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail, HttpError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { adressePublique, isAllowedMime, saveBuffer } from "@/modules/media/storage";

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
  /*
   * 🔴 L'USAGE DÉCIDE DU BUCKET, ET IL DOIT ÊTRE DIT À L'ENVOI.
   *
   * Cette route reçoit un fichier sans savoir ce qu'il deviendra : la
   * désignation — accueil de répondeur, sonnerie, photo de discussion — vient
   * APRÈS, dans une autre requête. Trop tard pour choisir où le poser.
   *
   * ⚠️ DEUX USAGES SEULEMENT PASSENT EN PUBLIC, et la liste est fermée à
   * dessein : l'accueil qu'on enregistre et la sonnerie qu'on choisit, parce
   * que l'un et l'autre sont de toute façon entendus par tous les appelants.
   * Tout le reste — y compris les messages laissés SUR le répondeur, qui sont
   * des enregistrements privés — va dans le bucket fermé.
   *
   * ⚠️ UN USAGE INCONNU RETOMBE EN PRIVÉ. Le défaut doit toujours être le plus
   * fermé : une faute de frappe côté client ne doit pas publier un fichier.
   */
  const usage = String(form.get("usage") ?? "").toLowerCase();
  const espace = usage === "accueil" || usage === "sonnerie" ? "public" : "prive";

  /*
   * 🔴 UN MÉDIA CHIFFRÉ DE BOUT EN BOUT (cours, chapitre 23).
   *
   * L'appareil a chiffré le fichier ; ce que nous recevons est illisible, et
   * doit le RESTER dans ce que nous en disons. On n'enregistre donc ni son nom
   * ni son type réels — ils vivent dans l'enveloppe Signal — mais un nom et un
   * type neutres. Le type du MESSAGE (photo, vidéo…) reste annoncé par le
   * client : décision du user du 03/10/2026, pour que la liste et les
   * notifications affichent encore « 📷 Photo ».
   *
   * ⚠️ JAMAIS DANS LE BUCKET PUBLIC : son adresse fixe le rendrait
   * téléchargeable par n'importe qui, sans même passer par nous.
   */
  const chiffre = form.get("chiffre") === "1";

  const { relativeUrl, espace: espaceRetenu } = await saveBuffer(
    buffer,
    chiffre ? "chiffre.bin" : file.name,
    chiffre ? "application/octet-stream" : file.type,
    chiffre ? "prive" : espace,
  ).catch((err) => {
    console.error("[media] Échec d'upload du stockage :", err);
    throw new HttpError(502, "Échec du téléversement du fichier", "STORAGE_ERROR");
  });

  // Durée éventuelle (audio/vidéo) fournie par le client.
  const durationRaw = form.get("durationMs");
  const durationMs = durationRaw ? Number(durationRaw) : null;

  const media = await prisma.mediaFile.create({
    data: {
      ownerId: userId,
      filename: chiffre ? "chiffre.bin" : file.name,
      mimeType: chiffre ? "application/octet-stream" : file.type,
      sizeBytes: file.size,
      chiffre,
      url: relativeUrl,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      // ⚠️ CE QUE `saveBuffer` A RÉELLEMENT FAIT, pas ce qu'on a demandé : le
      // bucket public peut ne pas être configuré, et l'envoi retombe alors dans
      // le privé. Écrire l'intention ferait chercher le fichier au mauvais
      // endroit, et il paraîtrait perdu.
      espace: espaceRetenu === "public" ? "public" : null,
    },
  });

  return ok(
    {
      id: media.id,
      // L'URL d'accès reste proxyfiée par le backend : cela garantit le contrôle
      // d'accès (owner/participant) quel que soit le backend de stockage.
      url: `/api/media/${media.id}`,
      /*
       * L'adresse FIXE, quand le média vit dans le bucket ouvert.
       *
       * ⚠️ EN PLUS DE `url`, JAMAIS À SA PLACE. Un client qui ne connaît pas ce
       * champ continue de passer par le serveur, et tout fonctionne comme
       * avant — c'est ce qui permet de déployer le backend sans attendre que
       * les trois applications soient à jour.
       */
      ...(adressePublique(media.url, media.espace)
        ? { urlPublique: adressePublique(media.url, media.espace) }
        : {}),
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      durationMs: media.durationMs,
    },
    201,
  );
});
