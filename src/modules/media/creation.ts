import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";
import { adressePublique, saveBuffer, type EspaceStockage } from "./storage";

/**
 * RANGER UN FICHIER ET CRÉER SA LIGNE `media_files` — ce que rend `POST /api/media`.
 *
 * 🔴 EXTRAIT, PAS RECOPIÉ (10/10/2026). Deux chemins mènent désormais à un
 * média : l'envoi d'un seul bloc (`POST /api/media`) et l'envoi en morceaux,
 * au moment de l'assemblage. Ils doivent ranger au même endroit, sous les
 * mêmes noms neutres pour un fichier chiffré, et rendre la même réponse — sans
 * quoi un client lirait deux formes selon la voie prise.
 */
export interface MediaCree {
  id: string;
  url: string;
  urlPublique?: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
}

export async function enregistrerMedia(args: {
  /**
   * Identifiant imposé. L'envoi en morceaux donne au média L'IDENTIFIANT DE
   * L'ENVOI : l'appareil le connaît dès la réservation, et peut donc le
   * sceller dans le descripteur chiffré avant que le fichier soit arrivé.
   */
  id?: string;
  ownerId: string;
  buffer: Buffer;
  nom: string;
  mime: string;
  /** Chiffré de bout en bout par l'appareil (cours, chapitre 23). */
  chiffre: boolean;
  espace: EspaceStockage;
  durationMs: number | null;
}): Promise<MediaCree> {
  const { id, ownerId, buffer, nom, mime, chiffre, espace, durationMs } = args;

  /*
   * 🔴 UN MÉDIA CHIFFRÉ : ni son nom ni son type réels — ils vivent dans
   * l'enveloppe Signal — et JAMAIS le bucket public, dont l'adresse fixe le
   * rendrait téléchargeable sans passer par nous.
   */
  const nomRange = chiffre ? "chiffre.bin" : nom;
  const mimeRange = chiffre ? "application/octet-stream" : mime;

  // On isole l'erreur de stockage pour renvoyer un code explicite plutôt qu'un
  // 400 générique — un échec B2/R2 n'est pas une mauvaise requête du client.
  const { relativeUrl, espace: espaceRetenu } = await saveBuffer(
    buffer,
    nomRange,
    mimeRange,
    chiffre ? "prive" : espace,
  ).catch((err) => {
    console.error("[media] Échec d'upload du stockage :", err);
    throw new HttpError(502, "Échec du téléversement du fichier", "STORAGE_ERROR");
  });

  const media = await prisma.mediaFile.create({
    data: {
      ...(id ? { id } : {}),
      ownerId,
      filename: nomRange,
      mimeType: mimeRange,
      sizeBytes: buffer.length,
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

  const publique = adressePublique(media.url, media.espace);
  return {
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
    ...(publique ? { urlPublique: publique } : {}),
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    durationMs: media.durationMs,
  };
}
