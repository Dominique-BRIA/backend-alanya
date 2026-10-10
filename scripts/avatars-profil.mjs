/**
 * LES PHOTOS DE PROFIL DANS LE SEAU `alanyaprofile` — état, copie, nettoyage.
 *
 * Usage, depuis le dossier du backend :
 *   node --env-file=.env scripts/avatars-profil.mjs --etat        combien sont copiées
 *   node --env-file=.env scripts/avatars-profil.mjs --publier     copie toutes les photos en cours
 *   node --env-file=.env scripts/avatars-profil.mjs --verifier    une photo, comme un téléphone la voit
 *   node --env-file=.env scripts/avatars-profil.mjs --nettoyer    retire les photos que plus personne n'a
 *   node scripts/avatars-profil.mjs --autocontrole                contrôles hors ligne
 *
 * 🔴 `--publier` NE COPIE RIEN LUI-MÊME : il demande chaque photo au serveur
 * (`/api/avatars/<id>`), qui la copie au passage. Une seule implémentation de la
 * règle — celle de l'API (`lib/avatar-profil.ts`) — et non une seconde ici, qui
 * finirait par diverger. Il faut donc que le serveur tourne AVEC
 * `STOCKAGE_PROFIL=r2` (après `pm2 restart … --update-env`).
 *
 * Rien n'est jamais retiré du seau privé : l'original y reste.
 */
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import {
  ESPACE_PROFIL,
  adresseProfil,
  cibleProfil,
  cleProfil,
  idAvatarDepuisUrl,
  relatifDepuisCle,
} from "../src/lib/seau-profil.mjs";
import { sonderAdressePublique } from "./copier-vers-r2.mjs";

const SERVEUR = (process.argv.find((a) => a.startsWith("--serveur=")) ?? "--serveur=http://127.0.0.1:3000").slice(10);
const EN_PARALLELE = 4;

function clientProfil(cible) {
  return new S3Client({
    endpoint: `https://${cible.endpoint}`,
    region: cible.region,
    credentials: { accessKeyId: cible.keyId, secretAccessKey: cible.secret },
    forcePathStyle: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Les identifiants des médias qui sont la photo d'un compte ou d'un groupe. */
async function photosEnCours(prisma) {
  const [comptes, groupes] = await Promise.all([
    prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
    prisma.conversation.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
  ]);
  const ids = new Set();
  for (const l of [...comptes, ...groupes]) {
    const id = idAvatarDepuisUrl(l.avatarUrl);
    if (id) ids.add(id);
  }
  return ids;
}

async function etat(prisma) {
  const enCours = await photosEnCours(prisma);
  const marques = await prisma.mediaFile.findMany({
    where: { espace: ESPACE_PROFIL },
    select: { id: true, url: true },
  });
  const copiees = marques.filter((m) => enCours.has(m.id));
  const orphelines = marques.filter((m) => !enCours.has(m.id));
  return { enCours, marques, copiees, orphelines };
}

async function* objets(client, bucket) {
  let jeton;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: jeton }));
    for (const o of page.Contents ?? []) yield { cle: o.Key, date: o.LastModified };
    jeton = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (jeton);
}

async function enParallele(liste, travail) {
  let i = 0;
  await Promise.all(
    Array.from({ length: EN_PARALLELE }, async () => {
      while (i < liste.length) await travail(liste[i++]);
    }),
  );
}

async function principal(args) {
  const cible = cibleProfil();
  if (!cible) {
    console.error(
      "✗ Le seau des photos n'est pas branché : il faut STOCKAGE_PROFIL=r2, R2_ENDPOINT, " +
        "R2_PROFIL_BUCKET, R2_PROFIL_KEY_ID, R2_PROFIL_SECRET_ACCESS_KEY et R2_PROFIL_URL dans .env.",
    );
    return 1;
  }
  const client = clientProfil(cible);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cible.bucket }));
    console.log(`✓ Cloudflare R2 répond (${cible.bucket})`);
  } catch (e) {
    console.error(`✗ Cloudflare R2 : ${e?.$metadata?.httpStatusCode === 403 ? "clé refusée" : e?.name || e}`);
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    if (args.includes("--publier")) {
      const avant = await etat(prisma);
      const aFaire = [...avant.enCours].filter((id) => !avant.copiees.some((m) => m.id === id));
      console.log(`\n${avant.enCours.size} photo(s) en cours, ${avant.copiees.length} déjà copiée(s), ${aFaire.length} à copier.`);
      const echecs = [];
      await enParallele(aFaire, async (id) => {
        try {
          const r = await fetch(`${SERVEUR}/api/avatars/${id}`, { redirect: "manual" });
          if (r.status !== 200 && r.status !== 302) echecs.push(`${id} — le serveur répond ${r.status}`);
          await r.arrayBuffer().catch(() => {});
        } catch (e) {
          echecs.push(`${id} — serveur injoignable (${e?.cause?.code || e?.message})`);
        }
      });
      // La copie se fait en arrière-plan côté serveur : on lui laisse le temps.
      await new Promise((ok) => setTimeout(ok, 6000));
      const apres = await etat(prisma);
      const restees = [...apres.enCours].filter((id) => !apres.copiees.some((m) => m.id === id));
      console.log(`\nCopiées : ${apres.copiees.length}/${apres.enCours.size}`);
      for (const e of echecs.slice(0, 10)) console.log(`  ✗ ${e}`);
      if (restees.length) {
        console.log(
          `${restees.length} restée(s) servie(s) par le serveur — relancer dans une minute. Celles qui restent ` +
            "sont refusées par principe (pas une image, chiffrée, ou mise en photo par quelqu'un d'autre que son propriétaire) :",
        );
        for (const id of restees.slice(0, 10)) console.log(`  · ${id}`);
      }
      return echecs.length ? 1 : 0;
    }

    if (args.includes("--verifier")) {
      const e = await etat(prisma);
      const une = e.copiees[0];
      if (!une) {
        console.log("\n✗ Aucune photo copiée : lancer --publier d'abord.");
        return 1;
      }
      const attendue = adresseProfil(une.url);
      let ok = true;
      const r = await fetch(`${SERVEUR}/api/avatars/${une.id}`, { redirect: "manual" });
      const location = r.headers.get("location");
      if (r.status === 302 && location === attendue) {
        console.log(`\n✓ /api/avatars/${une.id} renvoie vers Cloudflare`);
      } else {
        console.log(`\n✗ /api/avatars/${une.id} répond ${r.status}${location ? ` vers ${location}` : ""} — le serveur a-t-il été redémarré avec --update-env ?`);
        ok = false;
      }
      const sonde = await sonderAdressePublique(cible.base, cleProfil(une.url));
      for (const c of sonde.constats) console.log(`  ${c}`);
      return ok && sonde.ok ? 0 : 1;
    }

    if (args.includes("--nettoyer")) {
      const e = await etat(prisma);
      let retirees = 0;
      for (const m of e.orphelines) {
        await client.send(new DeleteObjectCommand({ Bucket: cible.bucket, Key: cleProfil(m.url) }));
        await prisma.mediaFile.updateMany({ where: { id: m.id, espace: ESPACE_PROFIL }, data: { espace: null } });
        retirees++;
      }
      // Les objets dont le média n'existe plus du tout (compte supprimé…).
      const connues = new Set(e.marques.map((m) => m.url));
      let sansMedia = 0;
      /*
       * ⚠️ PAS UN OBJET DE MOINS DE DIX MINUTES : une photo en cours de copie
       * est déjà dans le seau mais pas encore marquée en base. L'effacer à cet
       * instant laisserait une marque pointant sur un objet absent — une photo
       * vide, que rien ne réparerait.
       */
      const limite = Date.now() - 10 * 60 * 1000;
      for await (const { cle, date } of objets(client, cible.bucket)) {
        if (date && new Date(date).getTime() > limite) continue;
        const rel = relatifDepuisCle(cle);
        if (rel && connues.has(rel)) continue;
        const existe = rel ? await prisma.mediaFile.count({ where: { url: rel, espace: ESPACE_PROFIL } }) : 0;
        if (existe) continue;
        await client.send(new DeleteObjectCommand({ Bucket: cible.bucket, Key: cle }));
        sansMedia++;
      }
      console.log(`\nRetirées : ${retirees} photo(s) que plus personne n'a, ${sansMedia} objet(s) sans média.`);
      return 0;
    }

    const e = await etat(prisma);
    let nbObjets = 0;
    for await (const o of objets(client, cible.bucket)) if (o.cle) nbObjets++;
    console.log(`\nPhotos de profil et de groupe en cours : ${e.enCours.size}`);
    console.log(`Copiées dans ${cible.bucket} : ${e.copiees.length}`);
    console.log(`Encore servies par le serveur : ${e.enCours.size - e.copiees.length}`);
    console.log(`Copiées mais plus utilisées : ${e.orphelines.length}${e.orphelines.length ? "  (→ --nettoyer)" : ""}`);
    console.log(`Objets dans le seau : ${nbObjets}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/* ─────────────────────────────── Contrôles hors ligne */

function autoControle() {
  let ok = 0;
  let ko = 0;
  const v = (attendu, obtenu, libelle) => {
    const bon = JSON.stringify(attendu) === JSON.stringify(obtenu);
    if (bon) ok++;
    else ko++;
    console.log(`${bon ? "ok   " : "ECHEC"} ${libelle}${bon ? "" : ` — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`}`);
  };
  const id = "3f2a9c1e-8b7d-4e6f-9a01-23456789abcd";
  const complet = {
    STOCKAGE_PROFIL: "r2",
    R2_ENDPOINT: "https://abc.r2.cloudflarestorage.com/",
    R2_PROFIL_BUCKET: "alanyaprofile",
    R2_PROFIL_KEY_ID: "k",
    R2_PROFIL_SECRET_ACCESS_KEY: "s",
    R2_PROFIL_URL: "pub-123.r2.dev/",
  };
  const sansInterrupteur = { ...complet, STOCKAGE_PROFIL: undefined };

  v(null, cibleProfil(sansInterrupteur), "sans STOCKAGE_PROFIL=r2 : rien n'est branché");
  v(null, cibleProfil({ ...complet, R2_PROFIL_URL: "" }), "une variable manque : rien n'est branché");
  v(true, cibleProfil(complet) !== null && cibleProfil({ ...complet, STOCKAGE_PROFIL: " R2 " }) !== null, "STOCKAGE_PROFIL=r2 complet : branché (casse et espaces tolérés)");
  v("abc.r2.cloudflarestorage.com", cibleProfil(complet)?.endpoint, "l'adresse R2 accepte https:// et /");
  v(
    "https://pub-123.r2.dev/avatars/2026-10-10/x.jpg",
    adresseProfil("2026-10-10/x.jpg", complet),
    "adresse publique : base nettoyée + dossier avatars/",
  );
  v(null, adresseProfil("2026-10-10/x.jpg", sansInterrupteur), "débranché : pas d'adresse publique");
  v("avatars/2026-10-10/x.jpg", cleProfil("2026-10-10//x.jpg"), "la clé ne double jamais les /");
  v(["2026-10-10/x.jpg", null], [relatifDepuisCle("avatars/2026-10-10/x.jpg"), relatifDepuisCle("public/a.mp3")], "retour de la clé au chemin, seulement sous avatars/");
  v(id, idAvatarDepuisUrl(`https://alanyavox.com/api/avatars/${id}`), "forme absolue /api/avatars/<id>");
  v(id, idAvatarDepuisUrl(`/api/media/${id}`), "ancienne forme /api/media/<id>");
  v([null, null, null], [idAvatarDepuisUrl("data:image/png;base64,AAAA"), idAvatarDepuisUrl("https://autre.example/photo.jpg"), idAvatarDepuisUrl("/api/avatars/pas-un-uuid")], "data:, photo étrangère, identifiant invalide : pas à nous");
  v(null, idAvatarDepuisUrl(null), "pas de photo : rien");

  console.log(`\n${ok} contrôles OK, ${ko} en échec`);
  return ko === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
(args.includes("--autocontrole") ? Promise.resolve(autoControle()) : principal(args))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n✗ ${e?.message ?? e}`);
    process.exit(1);
  });
