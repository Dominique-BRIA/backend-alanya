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
  HeadBucketCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

// -----------------------------------------------------------------------------
// Client S3 singleton (compatible Backblaze B2).
// -----------------------------------------------------------------------------

let client: S3Client | null = null;

// Échoue tôt et clairement si B2 est sélectionné mais mal configuré.
function requireConfig(): void {
  if (!env.media.b2.isConfigured()) {
    throw new Error(
      "Backblaze B2 est activé (MEDIA_STORAGE_PROVIDER=b2) mais mal configuré. " +
        "Renseigne B2_BUCKET, B2_KEY_ID et B2_APPLICATION_KEY dans le .env.",
    );
  }
}

export function getB2(): S3Client {
  requireConfig();
  if (!client) {
    client = new S3Client({
      // Endpoint S3 fourni par Backblaze (ex : s3.us-west-004.backblazeb2.com).
      endpoint: `https://${env.media.b2.endpoint}`,
      // La "région" B2 correspond au suffixe du endpoint (ex : us-west-004).
      region: env.media.b2.region,
      credentials: {
        accessKeyId: env.media.b2.keyId,
        secretAccessKey: env.media.b2.applicationKey,
      },
      // Le style virtual-hosté (https://<bucket>.s3.<region>.backblazeb2.com)
      // est celui recommandé par Backblaze pour de meilleures performances.
      forcePathStyle: false,
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
    Bucket: env.media.b2.bucket,
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
    Bucket: env.media.b2.bucket,
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
    new GetObjectCommand({ Bucket: env.media.b2.bucket, Key: fullKey(relativeUrl) }),
  );
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

// Supprime un objet. "Best-effort" : on ne fait pas échouer l'opération
// métier si le fichier est déjà absent (idempotence de suppression).
export async function deleteFromB2(relativeUrl: string): Promise<void> {
  await getB2().send(
    new DeleteObjectCommand({ Bucket: env.media.b2.bucket, Key: fullKey(relativeUrl) }),
  );
}

// Vérifie que le bucket existe et que les identifiants sont valides.
// Utile au démarrage et dans le script de test.
export async function checkB2Connection(): Promise<void> {
  await getB2().send(new HeadBucketCommand({ Bucket: env.media.b2.bucket }));
}
