import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { ok, fail } from '@/lib/http';
import { routeV1, type CleAuthentifiee } from '@/lib/developer/authentifier';
import { CODE } from '@/lib/developer/api-contract';
import { isAllowedMime, saveBuffer } from '@/modules/media/storage';

const CHEMIN = '/api/v1/media';

/**
 * POST /api/v1/media — téléverse un fichier et rend son identifiant.
 *
 * 🔴 ELLE TÉLÉVERSE VRAIMENT, DEPUIS LE 21/08/2026. Elle ne le faisait pas :
 * elle enregistrait une **URL fournie par l'appelant** dans une table
 * `developer_medias` à part, avec `size: 1024` en dur et un type MIME jamais
 * vérifié. Trois conséquences, toutes réelles :
 *
 * - le fichier restait chez l'appelant, donc un lien mort chez lui cassait un
 *   message chez nous, longtemps après l'envoi ;
 * - la résolution d'un `media_id` **ne filtrait pas sur le propriétaire** —
 *   citer l'identifiant d'un autre abonné suffisait à joindre son fichier ;
 * - `developer_medias` faisait doublon avec `MediaFile`, si bien qu'un média
 *   d'API ne passait par aucun des contrôles d'accès de `/api/media/:id`.
 *
 * Elle réutilise maintenant **exactement** le chemin de `POST /api/media` :
 * `isAllowedMime` pour la liste blanche, le plafond `env.media.maxSizeMb`, et
 * `saveBuffer` pour le stockage (disque ou Backblaze B2 selon la
 * configuration). Le fichier devient un `MediaFile` ordinaire, propriété du
 * compte qui porte la clé, lisible par `/api/media/:id` avec son contrôle
 * d'accès. `developer_medias` n'est plus écrite par personne.
 *
 * Requête : `multipart/form-data`, champ `file`. Facultatif : `durationMs`
 * pour un audio ou une vidéo.
 */
export async function POST(req: NextRequest) {
  return routeV1(req, { chemin: CHEMIN, plafondParMinute: 30 }, (cle) => televerser(req, cle));
}

async function televerser(req: NextRequest, cle: CleAuthentifiee): Promise<Response> {
  /*
   * ⚠️ `req.formData()` LÈVE si le corps n'est pas du multipart — typiquement
   * quand l'appelant a envoyé du JSON, ce que faisait l'ancienne version de
   * cette route. Sans ce filet, il recevrait un 500 illisible là où le vrai
   * message est « changez de format ».
   */
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(
      'Corps attendu en multipart/form-data, avec un champ « file ».',
      400,
      CODE.REQUETE_INVALIDE,
    );
  }

  const fichier = form.get('file');
  if (!(fichier instanceof File)) {
    return fail('Champ « file » manquant.', 400, CODE.REQUETE_INVALIDE);
  }

  if (!isAllowedMime(fichier.type)) {
    return fail(`Type de fichier non autorisé : ${fichier.type}`, 415, CODE.MEDIA_TYPE_REFUSE);
  }

  const maxOctets = env.media.maxSizeMb * 1024 * 1024;
  if (fichier.size > maxOctets) {
    return fail(
      `Fichier trop volumineux (maximum ${env.media.maxSizeMb} Mo).`,
      413,
      CODE.MEDIA_TROP_VOLUMINEUX,
    );
  }

  const octets = Buffer.from(await fichier.arrayBuffer());

  /*
   * L'échec de stockage rend 502 et non 500 : la requête de l'appelant était
   * bonne, c'est notre dépendance qui a lâché. La distinction lui dit de
   * réessayer plus tard plutôt que de chercher son erreur.
   */
  let relativeUrl: string;
  try {
    ({ relativeUrl } = await saveBuffer(octets, fichier.name, fichier.type));
  } catch (erreur) {
    console.error('[v1 media] échec du stockage :', erreur);
    return fail('Échec du téléversement du fichier.', 502, CODE.STOCKAGE_INDISPONIBLE);
  }

  const dureeBrute = form.get('durationMs');
  const dureeMs = dureeBrute ? Number(dureeBrute) : null;

  const media = await prisma.mediaFile.create({
    data: {
      // Le propriétaire est le compte qui porte la clé : c'est ce qui rend le
      // contrôle de possession de `creerMessage` applicable aux médias d'API.
      ownerId: cle.userId,
      filename: fichier.name,
      mimeType: fichier.type,
      sizeBytes: fichier.size,
      url: relativeUrl,
      durationMs: Number.isFinite(dureeMs) ? dureeMs : null,
    },
  });

  return ok(
    {
      id: media.id,
      // URL proxyfiée, jamais l'URL de stockage : c'est elle qui porte le
      // contrôle d'accès, quel que soit le backend derrière.
      url: `/api/media/${media.id}`,
      nomFichier: media.filename,
      typeMime: media.mimeType,
      octets: media.sizeBytes,
      dureeMs: media.durationMs,
    },
    201,
  );
}
