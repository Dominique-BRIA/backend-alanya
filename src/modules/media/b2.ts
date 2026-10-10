// =============================================================================
// Backblaze B2 — couche d'accès au stockage objet (API compatible S3).
// =============================================================================
// On utilise le SDK AWS S3 v3, qui est l'API officielle recommandée par
// Backblaze pour l'intégration programmatique de B2 (compatibilité S3 totale).
//
// Le client est un singleton : on évite de recréer une connexion TLS à chaque
// upload, ce qui compte beaucoup pour les performances (handshake amorti).
// =============================================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  HeadBucketCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

// -----------------------------------------------------------------------------
// OÙ VIT LE SEAU PRIVÉ : Backblaze B2 (défaut) ou Cloudflare R2.
// -----------------------------------------------------------------------------
//
// 🔴 10/10/2026 : `STOCKAGE_PRIVE=r2` fait passer le seau privé chez Cloudflare
// R2. Les deux parlent l'API S3 : seuls l'adresse, la région, le nom du seau et
// la clé changent — et deux différences de comportement, traitées plus bas
// (sommes de contrôle, versions). Voir `env.media.r2`.

export interface CiblePrivee {
  fournisseur: "b2" | "r2";
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  secret: string;
}

let avertiR2Incomplet = false;

export function ciblePrivee(): CiblePrivee {
  const r2 = env.media.r2;
  if (r2.demande && r2.isConfigured()) {
    return {
      fournisseur: "r2",
      endpoint: r2.endpoint,
      region: r2.region || "auto",
      bucket: r2.bucket,
      keyId: r2.keyId,
      secret: r2.secretKey,
    };
  }
  /*
   * ⚠️ R2 DEMANDÉ MAIS INCOMPLET : ON RESTE CHEZ BACKBLAZE, et on le dit une
   * fois. Basculer vers une configuration à moitié remplie ferait échouer
   * chaque envoi et chaque lecture de fichier ; rester où l'on était garde le
   * service debout, et le point de santé le signale.
   */
  if (r2.demande && !avertiR2Incomplet) {
    avertiR2Incomplet = true;
    console.error(
      "[stockage] STOCKAGE_PRIVE=r2 mais R2_ENDPOINT, R2_BUCKET, R2_KEY_ID ou " +
        "R2_SECRET_ACCESS_KEY manque : le seau privé reste chez Backblaze.",
    );
  }
  return {
    fournisseur: "b2",
    endpoint: env.media.b2.endpoint,
    region: env.media.b2.region,
    bucket: env.media.b2.bucket,
    keyId: env.media.b2.keyId,
    secret: env.media.b2.applicationKey,
  };
}

// -----------------------------------------------------------------------------
// Client S3 singleton.
// -----------------------------------------------------------------------------

let client: S3Client | null = null;

// Échoue tôt et clairement si B2 est sélectionné mais mal configuré.
function requireConfig(): void {
  if (ciblePrivee().fournisseur === "b2" && !env.media.b2.isConfigured()) {
    throw new Error(
      "Backblaze B2 est activé (MEDIA_STORAGE_PROVIDER=b2) mais mal configuré. " +
        "Renseigne B2_BUCKET, B2_KEY_ID et B2_APPLICATION_KEY dans le .env.",
    );
  }
}

export function getB2(): S3Client {
  requireConfig();
  if (!client) {
    const cible = ciblePrivee();
    client = new S3Client({
      // Backblaze : s3.<région>.backblazeb2.com ; R2 : <compte>.r2.cloudflarestorage.com.
      endpoint: `https://${cible.endpoint}`,
      // Backblaze : le suffixe de l'adresse (us-west-004) ; R2 : « auto ».
      region: cible.region,
      credentials: { accessKeyId: cible.keyId, secretAccessKey: cible.secret },
      // Style virtual-hosté (https://<seau>.<adresse>) : recommandé par
      // Backblaze, accepté par R2.
      forcePathStyle: false,
      /*
       * ⚠️ R2 : LES SOMMES DE CONTRÔLE SEULEMENT QUAND ELLES SONT EXIGÉES.
       * Les versions récentes du SDK en ajoutent d'office à chaque envoi, sous
       * une forme que R2 n'accepte pas toujours : les téléversements y
       * échoueraient. C'est le réglage que recommande Cloudflare.
       */
      ...(cible.fournisseur === "r2"
        ? {
            requestChecksumCalculation: "WHEN_REQUIRED" as const,
            responseChecksumValidation: "WHEN_REQUIRED" as const,
          }
        : {}),
    });
  }
  return client;
}

// -----------------------------------------------------------------------------
// Helpers de clés : on isole toutes les opérations derrière un préfixe commun.
// -----------------------------------------------------------------------------

export function fullKey(relativeUrl: string): string {
  const prefix = env.media.b2.keyPrefix;
  if (relativeUrl.startsWith(prefix)) return relativeUrl;
  return `${prefix}${relativeUrl}`;
}

// -----------------------------------------------------------------------------
// Opérations de stockage.
// -----------------------------------------------------------------------------

interface UploadOptions {
  contentType: string;
  cacheControl?: string;
}

// Téléverse un binaire vers B2. Lève en cas d'échec réseau / d'authentification.
export async function uploadToB2(
  buffer: Buffer,
  relativeUrl: string,
  opts: UploadOptions,
): Promise<void> {
  const input: PutObjectCommandInput = {
    Bucket: ciblePrivee().bucket,
    Key: fullKey(relativeUrl),
    Body: buffer,
    ContentType: opts.contentType,
    // Les médias sont immuables (UUID en nom de fichier) : on peut les cacher
    // très longtemps côté CDN/navigateur sans risque de stale content.
    CacheControl: opts.cacheControl ?? "public, max-age=31536000, immutable",
  };
  await getB2().send(new PutObjectCommand(input));
}

interface SignedUrlOptions {
  expiresInSec?: number;
  // Override de l'en-tête Content-Disposition côté B2 (téléchargement forcé, etc.).
  responseContentDisposition?: string;
  responseContentType?: string;
}

// Génère une URL présignée (GET) à durée limitée pour un objet privé.
// Aucun appel réseau : c'est une simple signature cryptographique → très rapide.
export async function getB2SignedUrl(
  relativeUrl: string,
  opts: SignedUrlOptions = {},
): Promise<string> {
  const expiresIn = opts.expiresInSec ?? env.media.b2.presignExpiresInSec;
  const command = new GetObjectCommand({
    Bucket: ciblePrivee().bucket,
    Key: fullKey(relativeUrl),
    ...(opts.responseContentDisposition
      ? { ResponseContentDisposition: opts.responseContentDisposition }
      : {}),
    ...(opts.responseContentType ? { ResponseContentType: opts.responseContentType } : {}),
  });
  return getSignedUrl(getB2(), command, { expiresIn });
}

// Télécharge le binaire d'un objet dans un Buffer (utilisé uniquement en
// repli, quand on ne peut pas rediriger vers une URL présignée).
export async function readFromB2(relativeUrl: string): Promise<Buffer> {
  const out = await getB2().send(
    new GetObjectCommand({ Bucket: ciblePrivee().bucket, Key: fullKey(relativeUrl) }),
  );
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

// Supprime un objet. "Best-effort" : on ne fait pas échouer l'opération
// métier si le fichier est déjà absent (idempotence de suppression).
export async function deleteFromB2(relativeUrl: string): Promise<void> {
  await getB2().send(
    new DeleteObjectCommand({ Bucket: ciblePrivee().bucket, Key: fullKey(relativeUrl) }),
  );
}

/**
 * EFFACE UN OBJET POUR DE BON : toutes ses versions, et ses marqueurs de
 * suppression. Rend le nombre de versions effacées.
 *
 * 🔴 `deleteFromB2` NE SUFFIT PAS QUAND IL FAUT QUE LE FICHIER DISPARAISSE.
 * Un bucket B2 garde par défaut TOUTES les versions d'un fichier : un
 * `DeleteObject` sans version n'efface rien, il pose un marqueur qui CACHE
 * l'objet. Les octets restent dans le bucket, récupérables par quiconque
 * détient la clé. Pour une photo à vue unique, c'est exactement ce qu'on a
 * promis de ne pas faire.
 *
 * ⚠️ ELLE LÈVE, contrairement à `deleteFromB2` : un échec doit se voir et
 * laisser la ligne en base, pour que la purge suivante réessaie.
 *
 * ⚠️ On ne retient que la clé EXACTE : `Prefix` ramène aussi `a.jpg.bak`.
 */
export async function effacerToutesLesVersionsB2(relativeUrl: string): Promise<number> {
  const cle = fullKey(relativeUrl);
  /*
   * 🔴 R2 NE GARDE PAS DE VERSIONS, et ne connaît pas `ListObjectVersions` :
   * l'appeler y échouerait, et la photo à vue unique ne serait JAMAIS purgée.
   * Chez R2, une suppression simple est définitive — elle suffit.
   */
  if (ciblePrivee().fournisseur === "r2") {
    await getB2().send(new DeleteObjectCommand({ Bucket: ciblePrivee().bucket, Key: cle }));
    return 1;
  }
  const liste = await getB2().send(
    new ListObjectVersionsCommand({ Bucket: ciblePrivee().bucket, Prefix: cle }),
  );
  const versions = [...(liste.Versions ?? []), ...(liste.DeleteMarkers ?? [])].filter(
    (v) => v.Key === cle && v.VersionId,
  );
  for (const v of versions) {
    await getB2().send(
      new DeleteObjectCommand({ Bucket: ciblePrivee().bucket, Key: cle, VersionId: v.VersionId }),
    );
  }
  return versions.length;
}

// Vérifie que le bucket existe et que les identifiants sont valides.
// Utile au démarrage et dans le script de test.
export async function checkB2Connection(): Promise<void> {
  await getB2().send(new HeadBucketCommand({ Bucket: ciblePrivee().bucket }));
}
