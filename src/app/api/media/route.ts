import { type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isAllowedMime } from "@/modules/media/storage";
import { enregistrerMedia } from "@/modules/media/creation";

// POST /api/media — upload d'un fichier (multipart/form-data, champ "file").
// Le binaire est stocké sur disque (local) OU dans Backblaze B2 (cloud) selon
// MEDIA_STORAGE_PROVIDER ; seules les métadonnées vont en base.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Champ 'file' manquant", 400, "NO_FILE");

  // Un type vide — le navigateur ne connaît pas l'extension — est un fichier
  // ordinaire : on le range sous le type générique.
  const typeFichier = file.type || "application/octet-stream";
  if (!isAllowedMime(typeFichier)) {
    return fail(`Type de fichier non autorisé : ${typeFichier}`, 415, "BAD_MIME");
  }
  const maxBytes = env.media.maxSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return fail(`Fichier trop volumineux (max ${env.media.maxSizeMb} Mo)`, 413, "TOO_LARGE");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

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

  // Durée éventuelle (audio/vidéo) fournie par le client.
  const durationRaw = form.get("durationMs");
  const durationMs = durationRaw ? Number(durationRaw) : null;

  // Rangement et ligne `media_files` : partagés avec l'envoi en morceaux
  // (`src/modules/media/creation.ts`), qui doit produire exactement le même média.
  const media = await enregistrerMedia({
    ownerId: userId,
    buffer,
    nom: file.name,
    mime: typeFichier,
    chiffre,
    espace,
    durationMs,
  });

  return ok(media, 201);
});
