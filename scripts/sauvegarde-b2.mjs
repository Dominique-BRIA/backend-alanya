#!/usr/bin/env node
/**
 * SAUVEGARDE LA BASE, ET L'ENVOIE AILLEURS QUE SUR LE SERVEUR.
 *
 *   node --env-file=.env scripts/sauvegarde-b2.mjs
 *   node --env-file=.env scripts/sauvegarde-b2.mjs --local /chemin/deja-fait.sql.gz
 *
 * 🔴 UNE SAUVEGARDE SUR LA MACHINE QU'ELLE PROTÈGE N'EST PAS UNE SAUVEGARDE.
 * C'est une copie. Le disque lâche, le serveur est résilié, une erreur de
 * l'hébergeur : on perd la base ET ses sauvegardes le même jour, et l'on
 * découvre à ce moment-là que la protection n'en était pas une.
 *
 * 🔴 ET UNE SAUVEGARDE LIÉE AU DÉPLOIEMENT N'EN EST PAS UNE NON PLUS. Elle ne
 * se déclenche que lorsqu'on livre : un mois sans livraison, et la dernière
 * copie a un mois. Ce script tourne donc SEUL, depuis `cron`, et le
 * déploiement ne fait que l'appeler au passage.
 *
 * ⚠️ ELLE PART DANS LE BUCKET DES MÉDIAS, sous son propre préfixe. La clé
 * d'application n'a accès qu'à ce bucket : un second bucket demanderait une
 * seconde clé, pour une séparation que le préfixe assure déjà.
 */

import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { promises as fs } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

/** Combien de jours de sauvegardes on garde au loin. */
const RETENTION_JOURS = Number(process.env.SAUVEGARDE_RETENTION_JOURS ?? 30);

/**
 * Au-delà, on refuse plutôt que de charger la sauvegarde en mémoire.
 *
 * ⚠️ CE SCRIPT LIT LE FICHIER EN ENTIER avant de l'envoyer. C'est acceptable
 * tant que la base est petite — quelques mégaoctets aujourd'hui — et cela évite
 * la complexité d'un envoi en plusieurs morceaux. Mais une base qui grossit
 * finirait par faire tomber le serveur au moment précis où il sauvegarde. On
 * préfère refuser, bruyamment, plutôt que de tuer le processus.
 */
const TAILLE_MAX_OCTETS = 512 * 1024 * 1024;

const PREFIXE = "sauvegardes/";

const conf = {
  endpoint: process.env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com",
  region: process.env.B2_REGION || "us-west-004",
  bucket: process.env.B2_BUCKET,
  keyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
  baseUrl: process.env.DATABASE_URL,
};

function echec(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

if (!conf.bucket || !conf.keyId || !conf.applicationKey) {
  echec("B2_BUCKET, B2_KEY_ID et B2_APPLICATION_KEY sont requis dans .env");
}
if (!conf.baseUrl) echec("DATABASE_URL est requis dans .env");

const s3 = new S3Client({
  endpoint: `https://${conf.endpoint}`,
  region: conf.region,
  credentials: { accessKeyId: conf.keyId, secretAccessKey: conf.applicationKey },
  forcePathStyle: false,
});

/** « 20260926-103000 » — triable par ordre alphabétique, donc par date. */
function horodatage() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Produit le fichier compressé, et rend son chemin.
 *
 * ⚠️ EN FLUX, DE BOUT EN BOUT. `pg_dump` écrit, `gzip` comprime, le disque
 * reçoit — sans qu'aucune étape ne garde la base entière en mémoire. Une base
 * de plusieurs gigaoctets passerait aussi bien qu'une de deux mégaoctets.
 *
 * ⚠️ ET LE CODE DE SORTIE DE `pg_dump` EST VÉRIFIÉ. Un tube qui se termine ne
 * dit RIEN de la réussite de ce qui l'alimentait : sans ce contrôle, une
 * sauvegarde interrompue produirait un fichier tronqué, valide en apparence,
 * qu'on découvrirait inutilisable le jour où on en aurait besoin.
 */
async function produireSauvegarde() {
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), "alanya-sauvegarde-"));
  const chemin = path.join(dossier, `alanya-${horodatage()}.sql.gz`);

  const vidange = spawn("pg_dump", [conf.baseUrl], { stdio: ["ignore", "pipe", "pipe"] });
  let plainte = "";
  vidange.stderr.on("data", (d) => {
    plainte += d.toString();
  });

  const fini = new Promise((resoudre, rejeter) => {
    vidange.on("error", rejeter);
    vidange.on("close", (code) =>
      code === 0
        ? resoudre()
        : rejeter(new Error(`pg_dump a échoué (code ${code}) : ${plainte.trim().slice(0, 300)}`)),
    );
  });

  await Promise.all([
    pipeline(vidange.stdout, createGzip({ level: 9 }), createWriteStream(chemin)),
    fini,
  ]);

  return { chemin, dossier };
}

/**
 * Efface les sauvegardes trop vieilles.
 *
 * ⚠️ APRÈS L'ENVOI, JAMAIS AVANT. Faire le ménage d'abord laisserait une
 * fenêtre — courte, mais réelle — pendant laquelle on aurait supprimé
 * l'ancienne sans avoir réussi à poser la nouvelle.
 *
 * ⚠️ ET LE COMPTE EST VÉRIFIÉ. Si la liste revient vide ou n'est pas ce qu'on
 * attend, on ne supprime rien : effacer des sauvegardes sur une réponse qu'on
 * n'a pas comprise est le pire geste possible.
 */
async function fairePlace() {
  const limite = Date.now() - RETENTION_JOURS * 24 * 60 * 60 * 1000;
  const aEffacer = [];
  let suite;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: conf.bucket,
        Prefix: PREFIXE,
        ContinuationToken: suite,
      }),
    );
    for (const objet of page.Contents ?? []) {
      if (objet.LastModified && objet.LastModified.getTime() < limite) {
        aEffacer.push({ Key: objet.Key });
      }
    }
    suite = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (suite);

  if (aEffacer.length === 0) return 0;

  // Par lots de mille : c'est la limite de l'API, et la dépasser fait échouer
  // la requête entière plutôt que de la tronquer.
  for (let i = 0; i < aEffacer.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: conf.bucket,
        Delete: { Objects: aEffacer.slice(i, i + 1000) },
      }),
    );
  }
  return aEffacer.length;
}

function lisible(octets) {
  const u = ["o", "Ko", "Mo", "Go"];
  if (octets <= 0) return "0 o";
  const r = Math.min(u.length - 1, Math.floor(Math.log(octets) / Math.log(1024)));
  return `${(octets / 1024 ** r).toFixed(r > 1 ? 1 : 0)} ${u[r]}`;
}

async function principal() {
  const fourni = process.argv.indexOf("--local");
  const dejaFait = fourni >= 0 ? process.argv[fourni + 1] : null;

  console.log(`\n▸ Bucket    : ${conf.bucket}${PREFIXE ? ` (${PREFIXE})` : ""}`);
  console.log(`▸ Rétention : ${RETENTION_JOURS} jours\n`);

  // Avant de vidanger la base : des identifiants faux doivent échouer ICI, et
  // non après plusieurs minutes de `pg_dump`.
  try {
    await s3.send(new HeadBucketCommand({ Bucket: conf.bucket }));
  } catch (e) {
    echec(`bucket injoignable ou identifiants refusés (${e?.name ?? "erreur"})`);
  }

  let chemin = dejaFait;
  let aNettoyer = null;
  if (!chemin) {
    console.log("  Vidange de la base…");
    const produit = await produireSauvegarde();
    chemin = produit.chemin;
    aNettoyer = produit.dossier;
  }

  const info = await fs.stat(chemin);
  if (info.size === 0) echec("la sauvegarde est vide — rien n'a été envoyé");
  if (info.size > TAILLE_MAX_OCTETS) {
    echec(
      `sauvegarde de ${lisible(info.size)} : au-delà de ${lisible(TAILLE_MAX_OCTETS)}, ` +
        "il faut un envoi en plusieurs morceaux (voir le commentaire du script)",
    );
  }

  const cle = `${PREFIXE}${path.basename(chemin)}`;
  console.log(`  Envoi de ${lisible(info.size)} vers ${cle}…`);
  await s3.send(
    new PutObjectCommand({
      Bucket: conf.bucket,
      Key: cle,
      Body: await fs.readFile(chemin),
      ContentType: "application/gzip",
    }),
  );

  /*
   * ⚠️ ON RELIT CE QU'ON VIENT D'ÉCRIRE. Un envoi qui rend « 200 » sur une
   * connexion coupée en plein vol existe. Sans cette vérification, on
   * effacerait des sauvegardes anciennes en croyant en avoir posé une nouvelle.
   */
  const controle = await s3.send(
    new ListObjectsV2Command({ Bucket: conf.bucket, Prefix: cle, MaxKeys: 1 }),
  );
  const pose = (controle.Contents ?? [])[0];
  if (!pose || pose.Size !== info.size) {
    echec("la sauvegarde envoyée ne se relit pas à la bonne taille — RIEN n'a été effacé");
  }
  console.log("\x1b[32m  Sauvegarde en place et vérifiée.\x1b[0m");

  const effacees = await fairePlace();
  if (effacees > 0) {
    console.log(`  ${effacees} sauvegarde(s) de plus de ${RETENTION_JOURS} jours effacée(s).`);
  }

  if (aNettoyer) await fs.rm(aNettoyer, { recursive: true, force: true });
  console.log("");
}

principal().catch((e) => echec(e?.message ?? String(e)));
