import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { adresseOuverte, cibleOuverte, cleOuverte } from "@/lib/adresse-publique.mjs";

/**
 * LE BUCKET PUBLIC — ACCUEILS DE RÉPONDEUR ET SONNERIES.
 *
 * 🔴 POURQUOI UN SECOND BUCKET PLUTÔT QU'UN DOSSIER DANS LE PREMIER.
 *
 * Le bucket privé sert ses fichiers par URL SIGNÉE : le navigateur demande
 * l'adresse au serveur, le serveur la fabrique, le navigateur va la chercher.
 * Trois étapes, et une adresse qui change à chaque fois — donc jamais mise en
 * cache. Pour une photo de discussion, c'est le prix juste de la confidentialité.
 *
 * Pour un ACCUEIL DE RÉPONDEUR, c'est du temps perdu à l'instant précis où il
 * n'en faut pas : l'accueil doit démarrer quand la sonnerie s'arrête. Dans un
 * bucket public, son adresse est FIXE — pas de signature, pas d'aller-retour, et
 * le navigateur la garde en cache d'un appel à l'autre.
 *
 * ⚠️ N'Y METTRE QUE CE QUI EST DÉJÀ ENTENDU PAR TOUS LES APPELANTS : l'accueil
 * qu'on enregistre, la sonnerie qu'on choisit. JAMAIS un message laissé PAR
 * quelqu'un — celui-là est un enregistrement privé, et il reste dans le bucket
 * fermé. Cette frontière est la seule chose qui rend ce module acceptable.
 *
 * ⚠️ SA PROPRE CLÉ, ET SON PROPRE CLIENT. Une clé Backblaze vise UN bucket ou
 * TOUS ; prendre « tous » ouvrirait des buckets qui ne nous appartiennent pas.
 * Même règle chez Cloudflare : un jeton limité à CE seau.
 *
 * 🔴 10/10/2026 — BACKBLAZE OU CLOUDFLARE R2 (`STOCKAGE_PUBLIC=r2`). Le choix
 * est fait dans `lib/adresse-publique.mjs` (`cibleOuverte`), PAS ici : l'adresse
 * annoncée aux appelants et le seau où l'on écrit doivent venir de la même
 * décision.
 */

let client: S3Client | null = null;

export function publicConfigure(): boolean {
  return cibleOuverte() !== null;
}

/** Le nom du seau ouvert, chez l'hébergeur retenu. */
function seau(): string {
  return cibleOuverte()?.bucket ?? "";
}

function getB2Public(): S3Client {
  if (!client) {
    const cible = cibleOuverte();
    if (!cible) throw new Error("seau ouvert non configuré");
    client = new S3Client({
      // Même compte que le seau privé, chez l'un comme chez l'autre : seuls le
      // seau et la clé changent.
      endpoint: `https://${cible.endpoint}`,
      region: cible.region,
      credentials: { accessKeyId: cible.keyId, secretAccessKey: cible.secret },
      forcePathStyle: false,
      /*
       * ⚠️ R2 REFUSE LES SOMMES DE CONTRÔLE QUE LE SDK AJOUTE D'OFFICE — même
       * réglage, pour la même raison, que le client du seau privé (`b2.ts`).
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

/**
 * La clé de l'objet dans le bucket public.
 *
 * ⚠️ ELLE VIENT DE `lib/adresse-publique.mjs` ET NON D'ICI. `ws-server.mjs` est
 * un processus séparé qui ne peut pas importer de TypeScript : il a besoin de la
 * même règle, et deux copies de la même règle finissent toujours par diverger.
 */
export function publicKey(relativeUrl: string): string {
  return cleOuverte(relativeUrl);
}

/**
 * L'adresse publique et STABLE d'un objet.
 *
 * 🔴 C'EST TOUT L'INTÉRÊT DE CE MODULE. Elle ne change jamais, ne porte aucun
 * jeton, et n'expire pas : le navigateur la met en cache, et un accueil déjà
 * entendu ne se retélécharge pas. Une URL signée, elle, change à chaque
 * demande — le cache ne peut rien en faire.
 */
export function publicUrl(relativeUrl: string): string | null {
  /*
   * ⚠️ `null` PLUTÔT QU'UNE CHAÎNE VIDE quand le bucket n'est pas configuré. Une
   * chaîne vide traverserait les tests de vérité de JavaScript comme une adresse
   * — jusqu'à une redirection vers nulle part, trois appels plus loin, sans
   * qu'on sache d'où elle vient.
   */
  return adresseOuverte(relativeUrl, "public");
}

export async function uploadToB2Public(
  relativeUrl: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await getB2Public().send(
    new PutObjectCommand({
      Bucket: seau(),
      Key: publicKey(relativeUrl),
      Body: body,
      ContentType: contentType,
      /*
       * ⚠️ UN AN DE CACHE, ET C'EST SANS DANGER : le nom du fichier contient un
       * identifiant unique, donc un accueil MODIFIÉ est un fichier DIFFÉRENT,
       * à une autre adresse. On ne remplace jamais un contenu sous une adresse
       * existante — ce qui est précisément ce qui rendrait un cache long
       * dangereux.
       */
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/**
 * Retire un objet du bucket public.
 *
 * ⚠️ AU MIEUX : un fichier déjà absent n'est pas une erreur. Supprimer doit
 * pouvoir être rejoué sans conséquence.
 */
export async function deleteFromB2Public(relativeUrl: string): Promise<void> {
  try {
    await getB2Public().send(
      new DeleteObjectCommand({
        Bucket: seau(),
        Key: publicKey(relativeUrl),
      }),
    );
  } catch {
    /* déjà parti, ou jamais arrivé */
  }
}

/**
 * Lit un objet du bucket ouvert.
 *
 * 🔴 SERT LE REPLI, PAS LE CAS NORMAL. Normalement le client va chercher le
 * fichier DIRECTEMENT chez l'hébergeur, et ce serveur n'en voit pas un octet.
 * Mais un `fetch()` de navigateur vers un autre domaine exige des en-têtes CORS
 * sur le bucket : sans eux, le téléchargement échoue — et le préchargement de
 * l'accueil, qui est tout l'intérêt du dispositif, tombe silencieusement.
 *
 * ⚠️ POUR QUE LA CORRECTION NE DÉPENDE PAS D'UN RÉGLAGE DE CONSOLE. Le client
 * peut redemander le fichier par ce serveur (`?flux=1`), même origine, aucun
 * CORS en jeu. CORS bien réglé devient une ÉCONOMIE de bande passante, pas une
 * condition pour que le son arrive.
 */
export async function readFromB2Public(relativeUrl: string): Promise<Buffer> {
  const objet = await getB2Public().send(
    new GetObjectCommand({ Bucket: seau(), Key: publicKey(relativeUrl) }),
  );
  const corps = objet.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!corps?.transformToByteArray) throw new Error("corps illisible");
  return Buffer.from(await corps.transformToByteArray());
}

/** Les identifiants sont-ils acceptés, et le bucket existe-t-il ? */
export async function checkB2PublicConnection(): Promise<void> {
  await getB2Public().send(new HeadBucketCommand({ Bucket: seau() }));
}
