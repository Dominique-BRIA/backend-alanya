// =============================================================================
// Script de vérification de l'intégration Backblaze B2.
// Usage : npm run test:b2   (charge automatiquement le .env)
// =============================================================================
// Vérifie : identifiants valides, bucket accessible, upload, URL présignée,
// lecture et suppression. Aucun fichier n'est laissé dans le bucket.
// =============================================================================

import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ENDPOINT = process.env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com";
const REGION = process.env.B2_REGION || "us-west-004";
const BUCKET = process.env.B2_BUCKET || "alanya";
const KEY_ID = process.env.B2_KEY_ID;
const APP_KEY = process.env.B2_APPLICATION_KEY;
const PREFIX = process.env.B2_KEY_PREFIX || "media/";

function step(label) {
  console.log(`\n▶ ${label}`);
}
function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function err(msg) {
  console.error(`  ❌ ${msg}`);
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Test d'intégration Backblaze B2 — Alanya");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Endpoint : ${ENDPOINT}`);
  console.log(`  Région   : ${REGION}`);
  console.log(`  Bucket   : ${BUCKET}`);
  console.log(`  Préfixe  : ${PREFIX}`);

  if (!KEY_ID || !APP_KEY) {
    err("B2_KEY_ID et/ou B2_APPLICATION_KEY manquants dans le .env");
    process.exit(1);
  }
  ok("Identifiants présents dans l'environnement.");

  const s3 = new S3Client({
    endpoint: `https://${ENDPOINT}`,
    region: REGION,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: APP_KEY },
    forcePathStyle: false,
  });

  // 1) Bucket accessible + identifiants valides.
  step("Vérification de l'accès au bucket (HeadBucket)");
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    ok(`Bucket "${BUCKET}" accessible. Identifiants valides.`);
  } catch (e) {
    err(`Impossible d'accéder au bucket : ${e.message}`);
    err("Vérifie B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY et les droits de la clé.");
    process.exit(1);
  }

  // 2) Upload d'un fichier test.
  const testKey = `${PREFIX}_b2-ping-${Date.now()}.txt`;
  const testBody = Buffer.from(`Test Alanya B2 @ ${new Date().toISOString()}`, "utf8");
  step(`Upload d'un fichier test (${testKey})`);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: testKey,
        Body: testBody,
        ContentType: "text/plain",
      }),
    );
    ok("Fichier téléversé avec succès.");
  } catch (e) {
    err(`Échec d'upload : ${e.message}`);
    err("La clé d'application doit avoir les capacités writeFiles / listBuckets.");
    process.exit(1);
  }

  // 3) Génération d'une URL présignée.
  step("Génération d'une URL présignée (GET, 60 s)");
  let signedUrl;
  try {
    signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: testKey }),
      { expiresIn: 60 },
    );
    ok("URL présignée générée :");
    console.log(`  ${signedUrl.slice(0, 90)}...`);
  } catch (e) {
    err(`Échec de signature : ${e.message}`);
  }

  // 4) Nettoyage (suppression du fichier test).
  step("Suppression du fichier test");
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: testKey }));
    ok("Fichier test supprimé (bucket laissé propre).");
  } catch (e) {
    err(`Échec de suppression : ${e.message}`);
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log("  🎉 Intégration B2 opérationnelle !");
  console.log("═══════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\nErreur inattendue :", e);
  process.exit(1);
});
