import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { cibleProfil, cleProfil } from "@/lib/seau-profil.mjs";

/**
 * LE CLIENT DU SEAU DES PHOTOS DE PROFIL (`alanyaprofile`, Cloudflare R2).
 *
 * Les gestes bas niveau seulement : écrire, relire la taille, effacer. La règle
 * — quoi publier, quand retirer — vit dans `lib/avatar-profil.ts`, et la
 * décision « branché ou non » dans `lib/seau-profil.mjs`.
 *
 * ⚠️ CE MODULE N'IMPORTE PAS `storage.ts`, et c'est voulu : `storage.ts`
 * l'importe pour effacer la copie publique d'un média supprimé. L'inverse
 * créerait une boucle d'imports.
 *
 * ⚠️ SA PROPRE CLÉ, limitée à ce seau — même règle que les deux autres.
 */

let client: S3Client | null = null;

export function profilConfigure(): boolean {
  return cibleProfil() !== null;
}

function seau(): string {
  return cibleProfil()?.bucket ?? "";
}

function getClient(): S3Client {
  if (!client) {
    const cible = cibleProfil();
    if (!cible) throw new Error("seau des photos de profil non configuré");
    client = new S3Client({
      endpoint: `https://${cible.endpoint}`,
      region: cible.region,
      credentials: { accessKeyId: cible.keyId, secretAccessKey: cible.secret },
      forcePathStyle: false,
      // R2 refuse les sommes de contrôle que le SDK ajoute d'office (voir `b2.ts`).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

/**
 * Écrit une photo dans le seau.
 *
 * ⚠️ UN AN DE CACHE, SANS DANGER : une nouvelle photo est un nouvel envoi, donc
 * un nouvel identifiant et une autre adresse. Rien n'est jamais réécrit sous
 * une adresse existante.
 */
export async function ecrirePhotoProfil(relativeUrl: string, octets: Buffer, mime: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: seau(),
      Key: cleProfil(relativeUrl),
      Body: octets,
      ContentType: mime,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/** La taille de la photo dans le seau, ou `null` si elle n'y est pas. */
export async function taillePhotoProfil(relativeUrl: string): Promise<number | null> {
  try {
    const r = await getClient().send(new HeadObjectCommand({ Bucket: seau(), Key: cleProfil(relativeUrl) }));
    return Number(r.ContentLength ?? -1);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Retire une photo du seau. Déjà absente : ce n'est pas une erreur. */
export async function effacerPhotoProfil(relativeUrl: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: seau(), Key: cleProfil(relativeUrl) }));
}

/** Les identifiants sont-ils acceptés, et le seau existe-t-il ? */
export async function checkProfilConnection(): Promise<void> {
  await getClient().send(new HeadBucketCommand({ Bucket: seau() }));
}
