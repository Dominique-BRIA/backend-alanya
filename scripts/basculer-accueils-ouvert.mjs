#!/usr/bin/env node
/**
 * BASCULE LES ACCUEILS ET SONNERIES DÉJÀ ENREGISTRÉS VERS LE BUCKET OUVERT.
 *
 *   node --env-file=.env scripts/basculer-accueils-ouvert.mjs             # simulation
 *   node --env-file=.env scripts/basculer-accueils-ouvert.mjs --appliquer # pour de vrai
 *
 * 🔴 SANS CE SCRIPT, L'ACCÉLÉRATION NE S'APPLIQUE À PERSONNE D'EXISTANT.
 *
 * Les clients disent désormais `usage=accueil` en téléversant, donc les NOUVEAUX
 * accueils partent dans le bucket ouvert. Les anciens, eux, restent dans le
 * bucket privé avec `espace = NULL` : ils fonctionnent toujours — par URL
 * signée, donc jamais mis en cache — et rien ne les déplacera jamais tout seul.
 *
 * Un compte qui a déjà son accueil ne verrait donc AUCUNE différence, et l'on
 * conclurait que le dispositif ne marche pas. C'est la même classe de piège que
 * `migrer-medias-b2.mjs` traitait pour la bascule vers Backblaze : changer le
 * code ne déplace pas les octets déjà posés.
 *
 * ⚠️ L'ORDRE DES TROIS GESTES EST LA SEULE CHOSE QUI COMPTE ICI.
 *
 *   1. copier vers le bucket ouvert
 *   2. RELIRE, et comparer la taille
 *   3. seulement alors, écrire `espace = 'public'` en base
 *
 * Inversés, la base dirait « ce fichier est dans le bucket ouvert » avant qu'il
 * n'y soit : la route redirigerait vers une adresse vide, et l'accueil
 * deviendrait MUET — en silence, sans une erreur, pour tous les appelants de ce
 * compte. La base est ce qui décide où l'on va chercher ; elle doit changer en
 * DERNIER.
 *
 * ⚠️ RIEN N'EST SUPPRIMÉ DU BUCKET PRIVÉ. L'original est la seule marche arrière
 * qui existe : remettre `espace` à NULL suffit alors à tout rétablir. On paie
 * deux fois le stockage de quelques fichiers de cinq mégaoctets — c'est le prix
 * d'une bascule réversible, et il est dérisoire.
 */

import { PrismaClient } from "@prisma/client";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--appliquer");

const conf = {
  endpoint: process.env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com",
  region: process.env.B2_REGION || "us-west-004",
  // Le bucket privé — la SOURCE.
  bucket: process.env.B2_BUCKET,
  keyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
  prefixe: process.env.B2_KEY_PREFIX ?? "media/",
  // Le bucket ouvert — la DESTINATION.
  bucketOuvert: process.env.B2_PUBLIC_BUCKET,
  keyIdOuvert: process.env.B2_PUBLIC_KEY_ID,
  cleOuverte: process.env.B2_PUBLIC_APPLICATION_KEY,
  prefixeOuvert: process.env.B2_PUBLIC_KEY_PREFIX ?? "public/",
  // Le disque, quand le stockage n'est pas encore dans le nuage.
  nuage: (process.env.MEDIA_STORAGE_PROVIDER ?? "local") === "b2",
  racine: process.env.MEDIA_STORAGE_DIR || "./storage/media",
};

function echec(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

if (!conf.bucketOuvert || !conf.keyIdOuvert || !conf.cleOuverte) {
  echec("B2_PUBLIC_BUCKET, B2_PUBLIC_KEY_ID et B2_PUBLIC_APPLICATION_KEY sont requis dans .env");
}

/*
 * ⚠️ DEUX CLIENTS, ET IL EN FAUT DEUX. Une clé Backblaze vise UN bucket ou
 * TOUS : celle du privé ne peut pas écrire dans l'ouvert, et réciproquement.
 * Prendre une clé « tous les buckets » ouvrirait ceux qui ne nous appartiennent
 * pas.
 */
const prive = new S3Client({
  endpoint: `https://${conf.endpoint}`,
  region: conf.region,
  credentials: { accessKeyId: conf.keyId, secretAccessKey: conf.applicationKey },
});
const ouvert = new S3Client({
  endpoint: `https://${conf.endpoint}`,
  region: conf.region,
  credentials: { accessKeyId: conf.keyIdOuvert, secretAccessKey: conf.cleOuverte },
});

const clePrivee = (rel) => `${conf.prefixe}${rel}`.replace(/\/{2,}/g, "/");
const cleOuverte = (rel) => `${conf.prefixeOuvert}${rel}`.replace(/\/{2,}/g, "/");

/** Lit les octets là où ils sont aujourd'hui : bucket privé, ou disque. */
async function lireSource(rel) {
  if (conf.nuage) {
    const objet = await prive.send(
      new GetObjectCommand({ Bucket: conf.bucket, Key: clePrivee(rel) }),
    );
    return Buffer.from(await objet.Body.transformToByteArray());
  }
  // Même nettoyage que `readStored` : un `..` en base ferait sortir du dossier.
  const sain = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const racine = path.isAbsolute(conf.racine) ? conf.racine : path.join(process.cwd(), conf.racine);
  return fs.readFile(path.join(racine, sain));
}

/** L'objet est-il déjà là-bas, ET à la bonne taille ? */
async function dejaOuvert(rel, taille) {
  try {
    const tete = await ouvert.send(
      new HeadObjectCommand({ Bucket: conf.bucketOuvert, Key: cleOuverte(rel) }),
    );
    /*
     * ⚠️ ON COMPARE LES TAILLES. Une reprise après interruption peut retrouver
     * un objet ÉCRIT À MOITIÉ ; le tenir pour fait laisserait un accueil tronqué
     * que rien ne reprendrait, et qui se jouerait en grésillant des mois plus
     * tard.
     */
    return tete.ContentLength === taille;
  } catch {
    return false;
  }
}

function lisible(octets) {
  const u = ["o", "Ko", "Mo", "Go"];
  if (octets <= 0) return "0 o";
  const r = Math.min(u.length - 1, Math.floor(Math.log(octets) / Math.log(1024)));
  return `${(octets / 1024 ** r).toFixed(r > 1 ? 1 : 0)} ${u[r]}`;
}

/** Les médias à basculer : les accueils de répondeur et les sonneries importées. */
async function aBasculer() {
  const vus = new Set();
  const liste = [];

  const accueils = await prisma.repondeurAccueil.findMany({
    select: { media: { select: { id: true, url: true, espace: true, mimeType: true } } },
  });
  for (const a of accueils) {
    if (a.media && !vus.has(a.media.id)) {
      vus.add(a.media.id);
      liste.push({ ...a.media, quoi: "accueil" });
    }
  }

  /*
   * ⚠️ LES SONNERIES SONT DÉSIGNÉES PAR UNE CHAÎNE, pas par une clé étrangère :
   * `UserRingtone.url` porte « /api/media/<id> ». Le schéma explique pourquoi, et
   * ce n'est pas à ce script de le changer — il se contente d'en extraire
   * l'identifiant, et ignore toute valeur qui n'a pas cette forme.
   */
  const ids = [];
  const recolter = (valeur) => {
    const m = /\/api\/media\/([0-9a-fA-F-]{36})/.exec(valeur ?? "");
    if (m) ids.push(m[1]);
  };

  // Le catalogue des sonneries importées.
  for (const s of await prisma.userRingtone.findMany({ select: { url: true } })) {
    recolter(s.url);
  }

  /*
   * ⚠️ ET LES SONNERIES ASSIGNÉES AUX LISTES DE CONTACTS. `ContactList.ringtone`
   * et `ringtoneMessage` portent le même espace de noms : soit un nom de
   * sonnerie livrée avec l'application, soit une adresse « /api/media/<id> ».
   * Le filtre ne retient que la seconde forme.
   *
   * Sans ce balayage, une sonnerie EN USAGE mais absente du catalogue resterait
   * dans le bucket privé — et c'est justement celle qu'on entend le plus
   * souvent.
   */
  for (const l of await prisma.contactList.findMany({
    select: { ringtone: true, ringtoneMessage: true },
  })) {
    recolter(l.ringtone);
    recolter(l.ringtoneMessage);
  }
  if (ids.length > 0) {
    const medias = await prisma.mediaFile.findMany({
      where: { id: { in: ids } },
      select: { id: true, url: true, espace: true, mimeType: true },
    });
    for (const m of medias) {
      if (!vus.has(m.id)) {
        vus.add(m.id);
        liste.push({ ...m, quoi: "sonnerie" });
      }
    }
  }

  return liste;
}

async function basculerUn(media, compteurs) {
  if (media.espace === "public") {
    compteurs.dejaLa += 1;
    return;
  }
  /*
   * ⚠️ UNE ADRESSE `http` OU UNE DONNÉE `data:` N'EST PAS UN FICHIER STOCKÉ. La
   * première pointe ailleurs, la seconde porte l'image DANS la colonne — un cas
   * réellement présent en production, constaté le 26/09/2026. Ni l'une ni
   * l'autre ne se copie.
   */
  if (/^(https?:|data:)/i.test(media.url)) {
    compteurs.horsStockage.push(media.id);
    return;
  }

  let octets;
  try {
    octets = await lireSource(media.url);
  } catch (e) {
    compteurs.introuvables.push(`${media.id} (${e?.name ?? "erreur"})`);
    return;
  }

  if (!APPLIQUER) {
    compteurs.aFaire += 1;
    compteurs.octets += octets.length;
    return;
  }

  if (!(await dejaOuvert(media.url, octets.length))) {
    await ouvert.send(
      new PutObjectCommand({
        Bucket: conf.bucketOuvert,
        Key: cleOuverte(media.url),
        Body: octets,
        ContentType: media.mimeType || "application/octet-stream",
        /*
         * ⚠️ MÊMES EN-TÊTES QUE `uploadToB2Public`, et il le faut : un fichier
         * basculé à la main sans `Cache-Control` ne serait pas mis en cache, et
         * l'on aurait déplacé les octets sans obtenir le gain qui justifiait le
         * déplacement.
         */
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    // On RELIT avant de toucher la base. Un `PutObject` qui rend 200 sur une
    // connexion coupée en plein vol existe.
    if (!(await dejaOuvert(media.url, octets.length))) {
      throw new Error(`relecture incohérente pour ${media.id}`);
    }
  }

  // ET SEULEMENT MAINTENANT. La base décide où l'on va chercher : elle change en
  // dernier, quand le fichier est là et vérifié.
  await prisma.mediaFile.update({ where: { id: media.id }, data: { espace: "public" } });
  compteurs.bascules += 1;
  compteurs.octets += octets.length;
}

async function principal() {
  console.log(`\n▸ Source      : ${conf.nuage ? `${conf.bucket} (${conf.prefixe})` : conf.racine}`);
  console.log(`▸ Destination : ${conf.bucketOuvert} (${conf.prefixeOuvert})`);
  console.log(
    APPLIQUER
      ? "\x1b[33m▸ Mode        : APPLIQUER — les fichiers sont copiés et la base mise à jour\x1b[0m\n"
      : "\x1b[36m▸ Mode        : simulation — rien n'est écrit. Ajoute --appliquer.\x1b[0m\n",
  );

  // Des identifiants faux doivent échouer ICI, et non au milieu d'une bascule.
  try {
    await ouvert.send(new HeadBucketCommand({ Bucket: conf.bucketOuvert }));
    console.log("  Bucket ouvert joignable, identifiants acceptés.\n");
  } catch (e) {
    echec(`bucket ouvert injoignable ou identifiants refusés (${e?.name ?? "erreur"})`);
  }

  const liste = await aBasculer();
  const compteurs = {
    bascules: 0,
    dejaLa: 0,
    aFaire: 0,
    octets: 0,
    introuvables: [],
    horsStockage: [],
  };

  for (const media of liste) {
    await basculerUn(media, compteurs);
    process.stdout.write(`\r  ${compteurs.bascules + compteurs.dejaLa + compteurs.aFaire}/${liste.length} traités…`);
  }

  console.log("\n");
  console.log(`  Accueils et sonneries : ${liste.length}`);
  console.log(`  Déjà dans l'ouvert    : ${compteurs.dejaLa}`);
  if (APPLIQUER) {
    console.log(`  \x1b[32mBasculés              : ${compteurs.bascules} (${lisible(compteurs.octets)})\x1b[0m`);
  } else {
    console.log(`  \x1b[36mÀ basculer            : ${compteurs.aFaire} (${lisible(compteurs.octets)})\x1b[0m`);
  }

  if (compteurs.horsStockage.length > 0) {
    console.log(
      `\n  \x1b[33m⚠ ${compteurs.horsStockage.length} média(s) ne sont pas des fichiers stockés\x1b[0m`,
    );
    console.log("  (adresse externe, ou donnée encodée dans la colonne). Rien à copier.");
  }
  if (compteurs.introuvables.length > 0) {
    console.log(`\n  \x1b[33m⚠ ${compteurs.introuvables.length} média(s) illisibles à la source :\x1b[0m`);
    for (const x of compteurs.introuvables.slice(0, 10)) console.log(`      ${x}`);
    console.log("  Ils étaient DÉJÀ perdus : la bascule ne les a pas créés, et");
    console.log("  leur ligne en base n'a PAS été modifiée.");
  }

  if (!APPLIQUER && compteurs.aFaire > 0) {
    console.log("\n  Relance avec --appliquer pour basculer.");
  }
  console.log(
    "\n  \x1b[33mRien n'a été supprimé du bucket privé.\x1b[0m Pour revenir en arrière :",
  );
  console.log("      UPDATE media_files SET espace = NULL WHERE espace = 'public';\n");

  await prisma.$disconnect();
}

principal().catch(async (e) => {
  await prisma.$disconnect().catch(() => {});
  echec(e?.message ?? String(e));
});
