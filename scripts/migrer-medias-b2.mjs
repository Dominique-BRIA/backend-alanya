#!/usr/bin/env node
/**
 * MIGRE LES MÉDIAS DU DISQUE LOCAL VERS BACKBLAZE.
 *
 *   node --env-file=.env scripts/migrer-medias-b2.mjs            # simulation
 *   node --env-file=.env scripts/migrer-medias-b2.mjs --appliquer # pour de vrai
 *
 * 🔴 BASCULER `MEDIA_STORAGE_PROVIDER` NE DÉPLACE RIEN. Les fichiers déjà
 * déposés restent sur le disque du serveur : ils continuent de s'afficher tant
 * que cette machine vit, et disparaissent le jour où l'on en change — sans
 * prévenir, et sans qu'aucune erreur n'ait jamais été levée entre-temps. Les
 * lignes en base, elles, resteraient là, à promettre des fichiers introuvables.
 *
 * ⚠️ LA BASE N'EST PAS TOUCHÉE, ET C'EST VOULU. `MediaFile.url` porte un CHEMIN
 * RELATIF, identique des deux côtés : c'est `MEDIA_STORAGE_PROVIDER` qui décide
 * où le chercher. Migrer, c'est donc uniquement COPIER des octets — rien à
 * réécrire, rien à défaire si l'on revient en arrière.
 *
 * ⚠️ ET RIEN N'EST SUPPRIMÉ DU DISQUE. Tant que la copie n'est pas éprouvée en
 * production, l'original est la seule marche arrière qui existe. On efface plus
 * tard, à la main, quand on est sûr.
 */

import { PrismaClient } from "@prisma/client";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--appliquer");

/** Combien de fichiers on traite en même temps. */
const PARALLELE = 4;

const conf = {
  endpoint: process.env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com",
  region: process.env.B2_REGION || "us-west-004",
  bucket: process.env.B2_BUCKET,
  keyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
  prefixe: process.env.B2_KEY_PREFIX ?? "media/",
  racine: process.env.MEDIA_STORAGE_DIR || "./storage/media",
};

function echec(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

if (!conf.bucket || !conf.keyId || !conf.applicationKey) {
  echec("B2_BUCKET, B2_KEY_ID et B2_APPLICATION_KEY sont requis dans .env");
}

const s3 = new S3Client({
  endpoint: `https://${conf.endpoint}`,
  region: conf.region,
  credentials: { accessKeyId: conf.keyId, secretAccessKey: conf.applicationKey },
  forcePathStyle: false,
});

/** Le chemin absolu d'un média sur le disque de cette machine. */
function cheminLocal(relatif) {
  // ⚠️ MÊME NETTOYAGE QUE `readStored` : un `..` dans une valeur de base ferait
  // sortir du dossier de stockage. La base n'est pas une source sûre.
  const sain = path.normalize(relatif).replace(/^(\.\.(\/|\\|$))+/, "");
  const racine = path.isAbsolute(conf.racine) ? conf.racine : path.join(process.cwd(), conf.racine);
  return path.join(racine, sain);
}

/** La clé de l'objet dans le bucket — même règle que `fullKey` du backend. */
function cleObjet(relatif) {
  return `${conf.prefixe}${relatif}`.replace(/\/{2,}/g, "/");
}

async function dejaLaBas(relatif, taille) {
  try {
    const tete = await s3.send(
      new HeadObjectCommand({ Bucket: conf.bucket, Key: cleObjet(relatif) }),
    );
    /*
     * ⚠️ ON COMPARE LES TAILLES. Une reprise après interruption peut retrouver
     * un objet ÉCRIT À MOITIÉ ; le considérer comme fait laisserait un fichier
     * tronqué que rien ne reprendrait jamais, et qui s'ouvrirait en erreur des
     * mois plus tard.
     */
    return tete.ContentLength === taille;
  } catch {
    return false;
  }
}

async function migrerUn(media, compteurs) {
  const chemin = cheminLocal(media.url);

  let octets;
  try {
    octets = await fs.readFile(chemin);
  } catch {
    // Le binaire a disparu du disque alors que la ligne existe encore. Ce n'est
    // pas une panne de migration : c'est un média déjà perdu, qu'il faut
    // SIGNALER plutôt que de faire échouer tout le reste pour lui.
    compteurs.introuvables.push(media.url);
    return;
  }

  if (await dejaLaBas(media.url, octets.length)) {
    compteurs.dejaLa += 1;
    return;
  }

  if (!APPLIQUER) {
    compteurs.aFaire += 1;
    compteurs.octetsAFaire += octets.length;
    return;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: conf.bucket,
      Key: cleObjet(media.url),
      Body: octets,
      // Le type MIME voyage avec l'objet : sans lui, Backblaze sert tout en
      // `application/octet-stream` et le navigateur télécharge au lieu d'afficher.
      ContentType: media.mimeType || "application/octet-stream",
    }),
  );

  /*
   * ⚠️ ON RELIT CE QU'ON VIENT D'ÉCRIRE. Un `PutObject` qui rend 200 sur une
   * connexion coupée en plein vol existe ; sans cette vérification, on
   * compterait comme migré un objet tronqué, et l'on effacerait plus tard un
   * original qui était le seul exemplaire valable.
   */
  if (!(await dejaLaBas(media.url, octets.length))) {
    throw new Error(`relecture incohérente pour ${media.url}`);
  }
  compteurs.migres += 1;
  compteurs.octetsMigres += octets.length;
}

function lisible(octets) {
  const u = ["o", "Ko", "Mo", "Go", "To"];
  if (octets <= 0) return "0 o";
  const r = Math.min(u.length - 1, Math.floor(Math.log(octets) / Math.log(1024)));
  return `${(octets / 1024 ** r).toFixed(r > 1 ? 1 : 0)} ${u[r]}`;
}

async function principal() {
  console.log(`\n▸ Bucket   : ${conf.bucket} (${conf.endpoint})`);
  console.log(`▸ Préfixe  : ${conf.prefixe}`);
  console.log(`▸ Source   : ${conf.racine}`);
  console.log(
    APPLIQUER
      ? "\x1b[33m▸ Mode     : APPLIQUER — les fichiers sont réellement téléversés\x1b[0m\n"
      : "\x1b[36m▸ Mode     : simulation — rien n'est écrit. Ajoute --appliquer pour migrer.\x1b[0m\n",
  );

  // ⚠️ AVANT TOUT LE RESTE : des identifiants faux doivent échouer ICI, pas au
  // millième fichier après vingt minutes de travail inutile.
  try {
    await s3.send(new HeadBucketCommand({ Bucket: conf.bucket }));
    console.log("  Bucket joignable, identifiants acceptés.\n");
  } catch (e) {
    echec(`bucket injoignable ou identifiants refusés (${e?.name ?? "erreur"})`);
  }

  const compteurs = {
    total: 0,
    migres: 0,
    dejaLa: 0,
    aFaire: 0,
    octetsMigres: 0,
    octetsAFaire: 0,
    introuvables: [],
    donneesEnLigne: [],
  };

  /*
   * ⚠️ PAR PAGES, ET SUR UN CURSEUR. Un dépôt de production porte des dizaines
   * de milliers de médias : les charger tous mettrait en mémoire ce qu'on
   * cherche justement à déplacer. Le curseur avance sur l'identifiant — un
   * `skip` grandissant referait le même travail à chaque page.
   */
  let apres;
  for (;;) {
    const page = await prisma.mediaFile.findMany({
      orderBy: { id: "asc" },
      take: 200,
      ...(apres ? { cursor: { id: apres }, skip: 1 } : {}),
      select: { id: true, url: true, mimeType: true },
    });
    if (page.length === 0) break;

    /*
     * ⚠️ TROIS SORTES DE VALEURS DANS `url`, ET UNE SEULE SE MIGRE.
     *
     * Les adresses `http(s)` pointent ailleurs : rien à déplacer.
     *
     * 🐛 ET DES `data:` — constaté en production le 26/09/2026. Une ligne porte
     * une image entière encodée en base64 DANS la colonne, au lieu d'un chemin.
     * Ce média est déjà mort : `readStored` en fait un nom de fichier, ne le
     * trouve pas, et la route rend 410. La migration le signalait comme
     * « absent du disque », ce qui était vrai mais trompeur — ce n'est pas un
     * fichier perdu, c'est une donnée mal écrite, et les deux appellent des
     * gestes différents.
     */
    const locaux = [];
    for (const m of page) {
      if (/^https?:\/\//i.test(m.url)) continue;
      if (/^data:/i.test(m.url)) {
        compteurs.donneesEnLigne.push(m.id);
        continue;
      }
      locaux.push(m);
    }
    compteurs.total += locaux.length;

    for (let i = 0; i < locaux.length; i += PARALLELE) {
      const lot = locaux.slice(i, i + PARALLELE);
      await Promise.all(lot.map((m) => migrerUn(m, compteurs)));
      process.stdout.write(
        `\r  ${compteurs.migres + compteurs.dejaLa + compteurs.aFaire}/${compteurs.total} traités…`,
      );
    }
    apres = page[page.length - 1].id;
  }

  console.log("\n");
  console.log(`  Médias en base      : ${compteurs.total}`);
  console.log(`  Déjà sur Backblaze  : ${compteurs.dejaLa}`);
  if (APPLIQUER) {
    console.log(`  \x1b[32mMigrés              : ${compteurs.migres} (${lisible(compteurs.octetsMigres)})\x1b[0m`);
  } else {
    console.log(`  \x1b[36mÀ migrer            : ${compteurs.aFaire} (${lisible(compteurs.octetsAFaire)})\x1b[0m`);
  }

  if (compteurs.donneesEnLigne.length > 0) {
    console.log(
      `\n  \x1b[33m⚠ ${compteurs.donneesEnLigne.length} ligne(s) portent une image ENCODÉE dans la colonne\x1b[0m`,
    );
    console.log("  au lieu d'un chemin de fichier. Ces médias étaient déjà illisibles");
    console.log("  AVANT cette migration : la route rend 410 pour eux depuis toujours.");
    console.log("  Identifiants :");
    for (const id of compteurs.donneesEnLigne.slice(0, 10)) console.log(`      ${id}`);
    if (compteurs.donneesEnLigne.length > 10) {
      console.log(`      … et ${compteurs.donneesEnLigne.length - 10} autres`);
    }
  }

  if (compteurs.introuvables.length > 0) {
    console.log(
      `\n  \x1b[33m⚠ ${compteurs.introuvables.length} média(s) absent(s) du disque — la ligne existe, le fichier non :\x1b[0m`,
    );
    for (const u of compteurs.introuvables.slice(0, 10)) console.log(`      ${u}`);
    if (compteurs.introuvables.length > 10) {
      console.log(`      … et ${compteurs.introuvables.length - 10} autres`);
    }
    console.log(
      "  Ils étaient DÉJÀ perdus avant cette migration : elle ne les a pas créés.",
    );
  }

  if (!APPLIQUER && compteurs.aFaire > 0) {
    console.log("\n  Relance avec --appliquer pour téléverser.");
  }
  console.log(
    "\n  \x1b[33mRien n'a été supprimé du disque.\x1b[0m Les originaux sont ta seule marche",
  );
  console.log("  arrière : efface-les à la main, plus tard, une fois sûr.\n");

  await prisma.$disconnect();
}

principal().catch(async (e) => {
  await prisma.$disconnect().catch(() => {});
  echec(e?.message ?? String(e));
});
