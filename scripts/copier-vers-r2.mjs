/**
 * COPIER LES SEAUX DE BACKBLAZE VERS CLOUDFLARE R2 — décision du user, 10/10/2026.
 *
 * Usage, depuis le dossier du backend :
 *   node --env-file=.env scripts/copier-vers-r2.mjs --essai      compte, ne copie rien
 *   node --env-file=.env scripts/copier-vers-r2.mjs              copie ce qui manque
 *   node --env-file=.env scripts/copier-vers-r2.mjs --verifier   compare les deux seaux
 *   node --env-file=.env scripts/copier-vers-r2.mjs --inverse    R2 → Backblaze (retour arrière)
 *   node scripts/copier-vers-r2.mjs --autocontrole               contrôles hors ligne
 *
 * Ajouter `--public` à n'importe laquelle de ces commandes pour traiter le SEAU
 * OUVERT (accueils de répondeur, sonneries) au lieu du seau privé.
 *
 * Seau privé :
 *   Source : B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY (inchangées).
 *   Cible  : R2_ENDPOINT, R2_REGION (« auto »), R2_BUCKET, R2_KEY_ID, R2_SECRET_ACCESS_KEY.
 * Seau ouvert (`--public`) :
 *   Source : B2_ENDPOINT, B2_REGION, B2_PUBLIC_BUCKET, B2_PUBLIC_KEY_ID, B2_PUBLIC_APPLICATION_KEY.
 *   Cible  : R2_ENDPOINT, R2_REGION, R2_PUBLIC_BUCKET, R2_PUBLIC_KEY_ID, R2_PUBLIC_SECRET_ACCESS_KEY.
 *   `--verifier` interroge EN PLUS l'adresse publique (R2_PUBLIC_URL), comme le
 *   ferait un téléphone : répond-elle, avec le bon cache et le bon CORS ?
 *
 * ⚠️ LE CONTENT-TYPE ET LE CACHE-CONTROL SONT RECOPIÉS. Pour le seau ouvert,
 * c'est vital : un accueil sans `audio/…` ne joue pas dans un navigateur, et
 * sans `max-age` d'un an il serait retéléchargé à chaque appel.
 *
 * 🔴 RELANÇABLE SANS RISQUE. Un fichier déjà présent dans la cible avec la même
 * taille est sauté : on peut l'interrompre, le relancer, et surtout le relancer
 * APRÈS la bascule pour rattraper les fichiers envoyés entre-temps.
 *
 * 🔴 NE SUPPRIME RIEN, nulle part. Backblaze garde tout tant qu'on ne décide pas
 * explicitement de le vider.
 *
 * ⚠️ LES SAUVEGARDES DE LA BASE (`sauvegardes/`) NE SONT PAS COPIÉES : elles
 * continuent de s'écrire chez Backblaze (`scripts/sauvegarde-b2.mjs`). Les
 * garder chez un autre fournisseur que les fichiers est voulu. `--avec-sauvegardes`
 * les copie quand même.
 *
 * ⚠️ LES CLÉS SONT RECOPIÉES À L'IDENTIQUE (`media/2026-10-07/<uuid>.jpg`) : la
 * base ne range que ce chemin, sans le nom de l'hébergeur — aucune ligne n'est à
 * modifier.
 */
import { Readable } from "node:stream";
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const PREFIXE_SAUVEGARDES = "sauvegardes/";
const EN_PARALLELE = 4;

/* ─────────────────────────────── Clients */

function sansProtocole(adresse) {
  return String(adresse ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function clientS3({ endpoint, region, keyId, secret, r2 }) {
  return new S3Client({
    endpoint: `https://${sansProtocole(endpoint)}`,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    forcePathStyle: false,
    // Même réglage que `src/modules/media/b2.ts` : R2 refuse certaines sommes
    // de contrôle que le SDK ajoute d'office.
    ...(r2 ? { requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" } : {}),
  });
}

/**
 * Les noms des variables à lire, selon le seau traité.
 *
 * ⚠️ LE SEAU OUVERT A SES PROPRES CLÉS, chez les deux hébergeurs : chaque clé ne
 * voit qu'un seau. Celle du privé ne peut ni lire ni écrire l'ouvert.
 */
function variables(ouvert) {
  return ouvert
    ? {
        b2: { bucket: "B2_PUBLIC_BUCKET", keyId: "B2_PUBLIC_KEY_ID", secret: "B2_PUBLIC_APPLICATION_KEY" },
        r2: { bucket: "R2_PUBLIC_BUCKET", keyId: "R2_PUBLIC_KEY_ID", secret: "R2_PUBLIC_SECRET_ACCESS_KEY" },
      }
    : {
        b2: { bucket: "B2_BUCKET", keyId: "B2_KEY_ID", secret: "B2_APPLICATION_KEY" },
        r2: { bucket: "R2_BUCKET", keyId: "R2_KEY_ID", secret: "R2_SECRET_ACCESS_KEY" },
      };
}

function seauxDepuisEnv(env, { ouvert = false } = {}) {
  const v = variables(ouvert);
  const manque = [];
  for (const nom of [v.b2.bucket, v.b2.keyId, v.b2.secret, "R2_ENDPOINT", v.r2.bucket, v.r2.keyId, v.r2.secret]) {
    if (!env[nom]) manque.push(nom);
  }
  if (manque.length) throw new Error(`Variables manquantes dans .env : ${manque.join(", ")}`);
  const b2 = {
    nom: "Backblaze",
    bucket: env[v.b2.bucket],
    client: clientS3({
      endpoint: env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com",
      region: env.B2_REGION || "us-west-004",
      keyId: env[v.b2.keyId],
      secret: env[v.b2.secret],
      r2: false,
    }),
  };
  const r2 = {
    nom: "Cloudflare R2",
    bucket: env[v.r2.bucket],
    client: clientS3({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      keyId: env[v.r2.keyId],
      secret: env[v.r2.secret],
      r2: true,
    }),
  };
  return { b2, r2 };
}

/* ─────────────────────────────── Opérations */

/** Tous les objets d'un seau, page par page. */
export async function* lister(seau) {
  let jeton;
  do {
    const page = await seau.client.send(
      new ListObjectsV2Command({ Bucket: seau.bucket, ContinuationToken: jeton }),
    );
    for (const o of page.Contents ?? []) yield { cle: o.Key, taille: Number(o.Size ?? 0) };
    jeton = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (jeton);
}

function absent(e) {
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Copie UN objet, sauf s'il est déjà là avec la même taille. Rend « deja » ou « copie ». */
export async function copierUn(source, cible, cle, taille) {
  try {
    const t = await cible.client.send(new HeadObjectCommand({ Bucket: cible.bucket, Key: cle }));
    if (Number(t.ContentLength ?? -1) === taille) return "deja";
  } catch (e) {
    if (!absent(e)) throw e;
  }
  const obj = await source.client.send(new GetObjectCommand({ Bucket: source.bucket, Key: cle }));
  await cible.client.send(
    new PutObjectCommand({
      Bucket: cible.bucket,
      Key: cle,
      // En flux : un fichier de 250 Mo ne passe jamais en entier en mémoire.
      Body: obj.Body,
      ContentLength: Number(obj.ContentLength ?? taille),
      ContentType: obj.ContentType,
      CacheControl: obj.CacheControl,
      ContentDisposition: obj.ContentDisposition,
      Metadata: obj.Metadata,
    }),
  );
  return "copie";
}

const retenu = (cle, avecSauvegardes) => avecSauvegardes || !cle.startsWith(PREFIXE_SAUVEGARDES);

/** Copie tout ce qui manque. Une panne sur un fichier n'arrête pas les autres. */
export async function copierTout(source, cible, { essai = false, avecSauvegardes = false, journal = console.log } = {}) {
  const bilan = { vus: 0, copies: 0, deja: 0, octets: 0, echecs: [] };
  const aFaire = [];
  for await (const o of lister(source)) {
    if (!retenu(o.cle, avecSauvegardes)) continue;
    bilan.vus++;
    bilan.octets += o.taille;
    aFaire.push(o);
  }
  if (essai) return bilan;

  let suivant = 0;
  let faits = 0;
  async function ouvrier() {
    while (suivant < aFaire.length) {
      const o = aFaire[suivant++];
      try {
        const r = await copierUn(source, cible, o.cle, o.taille);
        if (r === "deja") bilan.deja++;
        else bilan.copies++;
      } catch (e) {
        bilan.echecs.push({ cle: o.cle, raison: e?.name || e?.message || String(e) });
      }
      faits++;
      if (faits % 25 === 0 || faits === aFaire.length) {
        journal(`  ${faits}/${aFaire.length} — ${bilan.copies} copiés, ${bilan.deja} déjà là, ${bilan.echecs.length} en échec`);
      }
    }
  }
  await Promise.all(Array.from({ length: EN_PARALLELE }, ouvrier));
  return bilan;
}

/** Compare les deux seaux : ce qui manque dans la cible, ou n'y a pas la même taille. */
export async function verifier(source, cible, { avecSauvegardes = false } = {}) {
  const dansCible = new Map();
  for await (const o of lister(cible)) dansCible.set(o.cle, o.taille);
  const bilan = { source: 0, manquants: [], differents: [] };
  for await (const o of lister(source)) {
    if (!retenu(o.cle, avecSauvegardes)) continue;
    bilan.source++;
    if (!dansCible.has(o.cle)) bilan.manquants.push(o.cle);
    else if (dansCible.get(o.cle) !== o.taille) bilan.differents.push(o.cle);
  }
  return bilan;
}

/**
 * L'ADRESSE PUBLIQUE SERT-ELLE LE FICHIER, COMME UN TÉLÉPHONE LE DEMANDERAIT ?
 *
 * 🔴 « LES DEUX SEAUX CONCORDENT » NE SUFFIT PAS POUR LE SEAU OUVERT. Les
 * fichiers peuvent être tous là et l'adresse publique muette : accès public non
 * activé chez Cloudflare, `R2_PUBLIC_URL` mal recopiée. On demande donc UN
 * fichier par l'adresse publique, avec l'origine du web, et l'on regarde les
 * trois choses qui comptent : la réponse, le cache, le CORS.
 *
 * Rend une liste de constats ; `ok` est faux si le fichier n'est pas servi.
 */
export async function sonderAdressePublique(base, cle, { origine = "https://alanyavox.com", fetchFn = fetch } = {}) {
  const adresse = `${String(base).replace(/\/+$/, "")}/${cle}`;
  let r;
  try {
    r = await fetchFn(adresse, { method: "HEAD", headers: { Origin: origine } });
  } catch (e) {
    return { ok: false, constats: [`✗ ${adresse} injoignable (${e?.cause?.code || e?.message || e})`] };
  }
  const constats = [];
  const ok = r.status === 200;
  constats.push(
    ok
      ? `✓ l'adresse publique sert les fichiers (${r.status})`
      : `✗ l'adresse publique répond ${r.status} — accès public non activé dans Cloudflare, ou R2_PUBLIC_URL fausse`,
  );
  if (ok) {
    const cache = r.headers.get("cache-control") || "";
    constats.push(
      /max-age=\d{6,}/.test(cache)
        ? `✓ cache long transmis (${cache})`
        : `✗ pas de cache long (${cache || "aucun"}) — l'accueil serait retéléchargé à chaque appel`,
    );
    const cors = r.headers.get("access-control-allow-origin");
    constats.push(
      cors === "*" || cors === origine
        ? `✓ CORS accepte ${origine}`
        : `✗ pas de CORS pour ${origine} — le web passera par le serveur (plus lent) : ajouter la règle CORS au seau`,
    );
  }
  return { ok, constats };
}

/* ─────────────────────────────── Programme */

const mo = (n) => `${(n / 1024 / 1024).toFixed(1)} Mo`;

async function principal(args) {
  const ouvert = args.includes("--public");
  const { b2, r2 } = seauxDepuisEnv(process.env, { ouvert });
  const inverse = args.includes("--inverse");
  const [source, cible] = inverse ? [r2, b2] : [b2, r2];
  const avecSauvegardes = args.includes("--avec-sauvegardes");

  console.log(`\n${ouvert ? "SEAU OUVERT — " : ""}De ${source.nom} (${source.bucket}) vers ${cible.nom} (${cible.bucket})`);
  for (const s of [source, cible]) {
    try {
      await s.client.send(new HeadBucketCommand({ Bucket: s.bucket }));
      console.log(`  ✓ ${s.nom} répond`);
    } catch (e) {
      console.error(`  ✗ ${s.nom} : ${e?.$metadata?.httpStatusCode === 403 ? "clé refusée" : e?.name || e}`);
      return 1;
    }
  }

  if (args.includes("--verifier")) {
    const v = await verifier(source, cible, { avecSauvegardes });
    console.log(`\nFichiers dans ${source.nom} : ${v.source}`);
    console.log(`Manquants dans ${cible.nom} : ${v.manquants.length}`);
    console.log(`Taille différente : ${v.differents.length}`);
    for (const c of [...v.manquants, ...v.differents].slice(0, 20)) console.log(`  · ${c}`);
    let ok = v.manquants.length === 0 && v.differents.length === 0;
    console.log(ok ? "\n✓ Les deux seaux concordent." : "\n✗ Relancer la copie (sans --verifier), puis vérifier de nouveau.");
    if (ouvert && !inverse) {
      const base = process.env.R2_PUBLIC_URL;
      let premier = null;
      for await (const o of lister(cible)) {
        premier = o.cle;
        break;
      }
      if (!base) {
        console.log("\n✗ R2_PUBLIC_URL absente du .env : l'adresse publique n'a pas pu être essayée.");
        ok = false;
      } else if (!premier) {
        console.log("\n(Seau vide : l'adresse publique n'a pas pu être essayée.)");
      } else {
        const base2 = /^https?:\/\//.test(base) ? base : `https://${base}`;
        const sonde = await sonderAdressePublique(base2, premier);
        console.log("\nAdresse publique :");
        for (const c of sonde.constats) console.log(`  ${c}`);
        ok = ok && sonde.ok;
      }
    }
    return ok ? 0 : 1;
  }

  const essai = args.includes("--essai");
  const bilan = await copierTout(source, cible, { essai, avecSauvegardes });
  console.log(`\n${bilan.vus} fichier(s), ${mo(bilan.octets)} au total.`);
  if (essai) {
    console.log("Essai : rien n'a été copié.");
    return 0;
  }
  console.log(`Copiés : ${bilan.copies} · déjà présents : ${bilan.deja} · en échec : ${bilan.echecs.length}`);
  for (const e of bilan.echecs.slice(0, 20)) console.log(`  ✗ ${e.cle} — ${e.raison}`);
  if (bilan.echecs.length) console.log("Relancer le script : il reprendra là où il en est.");
  return bilan.echecs.length ? 1 : 0;
}

/* ─────────────────────────────── Contrôles hors ligne */

/** Un faux seau S3 en mémoire : liste paginée, tête, lecture, écriture. */
function fauxSeau(nom, objets = {}, { parPage = 2, panne = null } = {}) {
  const contenu = new Map(Object.entries(objets).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    nom,
    bucket: nom,
    contenu,
    client: {
      async send(cmd) {
        const i = cmd.input;
        switch (cmd.constructor.name) {
          case "ListObjectsV2Command": {
            const cles = [...contenu.keys()].sort();
            const debut = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
            const page = cles.slice(debut, debut + parPage);
            const reste = debut + parPage < cles.length;
            return {
              Contents: page.map((k) => ({ Key: k, Size: contenu.get(k).length })),
              IsTruncated: reste,
              NextContinuationToken: reste ? String(debut + parPage) : undefined,
            };
          }
          case "HeadObjectCommand":
            if (!contenu.has(i.Key)) throw Object.assign(new Error("absent"), { name: "NotFound" });
            return { ContentLength: contenu.get(i.Key).length };
          case "GetObjectCommand":
            if (i.Key === panne) throw Object.assign(new Error("panne"), { name: "InternalError" });
            return { Body: Readable.from(contenu.get(i.Key)), ContentLength: contenu.get(i.Key).length, ContentType: "image/jpeg" };
          case "PutObjectCommand": {
            const morceaux = [];
            for await (const m of i.Body) morceaux.push(m);
            contenu.set(i.Key, Buffer.concat(morceaux));
            return {};
          }
          default:
            throw new Error(`commande inattendue : ${cmd.constructor.name}`);
        }
      },
    },
  };
}

async function autoControle() {
  let ok = 0;
  let ko = 0;
  const v = (attendu, obtenu, libelle) => {
    const bon = JSON.stringify(attendu) === JSON.stringify(obtenu);
    bon ? ok++ : ko++;
    console.log(`${bon ? "ok   " : "ECHEC"} ${libelle}${bon ? "" : ` — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`}`);
  };
  const muet = () => {};

  // 1. Copie complète, sur plusieurs pages, sans les sauvegardes.
  const src = fauxSeau("b2", {
    "media/a.jpg": "aaaa",
    "media/b.pdf": "bbbbbbbb",
    "media/c.mp4": "cc",
    "sauvegardes/base.sql.gz": "zzzz",
  });
  const dst = fauxSeau("r2");
  const b1 = await copierTout(src, dst, { journal: muet });
  v(3, b1.copies, "trois fichiers copiés, sur deux pages de liste");
  v(false, dst.contenu.has("sauvegardes/base.sql.gz"), "les sauvegardes de la base ne sont pas copiées");
  v("bbbbbbbb", dst.contenu.get("media/b.pdf")?.toString(), "le contenu arrive intact, sous la même clé");

  // 2. Relancé : rien n'est recopié.
  const b2 = await copierTout(src, dst, { journal: muet });
  v([0, 3], [b2.copies, b2.deja], "relancé, il saute tout ce qui est déjà là");

  // 3. Une taille différente est recopiée.
  dst.contenu.set("media/a.jpg", Buffer.from("a"));
  const b3 = await copierTout(src, dst, { journal: muet });
  v([1, "aaaa"], [b3.copies, dst.contenu.get("media/a.jpg").toString()], "une copie tronquée est refaite");

  // 4. Vérification.
  const ver = await verifier(src, dst);
  v([3, 0, 0], [ver.source, ver.manquants.length, ver.differents.length], "après copie, les deux seaux concordent");
  const vide = fauxSeau("vide");
  const ver2 = await verifier(src, vide);
  v(3, ver2.manquants.length, "un seau vide : trois manquants signalés");

  // 5. Une panne sur un fichier n'arrête pas les autres.
  const src2 = fauxSeau("b2", { "media/1": "1", "media/2": "22", "media/3": "333" }, { panne: "media/2" });
  const dst2 = fauxSeau("r2");
  const b5 = await copierTout(src2, dst2, { journal: muet });
  v([2, 1, "media/2"], [b5.copies, b5.echecs.length, b5.echecs[0]?.cle], "un échec est compté, les autres passent");

  // 6. Essai : rien n'est écrit.
  const dst3 = fauxSeau("r2");
  const b6 = await copierTout(src, dst3, { essai: true, journal: muet });
  v([3, 14, 0], [b6.vus, b6.octets, dst3.contenu.size], "en essai, il compte sans rien copier");

  // 7. Avec les sauvegardes.
  const dst4 = fauxSeau("r2");
  await copierTout(src, dst4, { avecSauvegardes: true, journal: muet });
  v(true, dst4.contenu.has("sauvegardes/base.sql.gz"), "--avec-sauvegardes les copie aussi");

  // 8. Variables manquantes : refus clair.
  let message = "";
  try {
    seauxDepuisEnv({ B2_BUCKET: "x" });
  } catch (e) {
    message = e.message;
  }
  v(true, message.includes("R2_SECRET_ACCESS_KEY"), "une variable R2 manquante est nommée");
  v("abc.r2.cloudflarestorage.com", sansProtocole("https://abc.r2.cloudflarestorage.com/"), "l'adresse accepte https:// et /");

  // 9. Le seau ouvert lit SES variables, pas celles du privé.
  let message2 = "";
  try {
    seauxDepuisEnv(
      { B2_BUCKET: "x", B2_KEY_ID: "x", B2_APPLICATION_KEY: "x", R2_ENDPOINT: "x", R2_BUCKET: "x", R2_KEY_ID: "x", R2_SECRET_ACCESS_KEY: "x" },
      { ouvert: true },
    );
  } catch (e) {
    message2 = e.message;
  }
  v(true, message2.includes("B2_PUBLIC_BUCKET") && message2.includes("R2_PUBLIC_SECRET_ACCESS_KEY"), "--public exige les clés du seau ouvert");
  const pub = seauxDepuisEnv(
    { B2_PUBLIC_BUCKET: "profilemedia", B2_PUBLIC_KEY_ID: "a", B2_PUBLIC_APPLICATION_KEY: "b", R2_ENDPOINT: "x", R2_PUBLIC_BUCKET: "ouvert", R2_PUBLIC_KEY_ID: "c", R2_PUBLIC_SECRET_ACCESS_KEY: "d" },
    { ouvert: true },
  );
  v(["profilemedia", "ouvert"], [pub.b2.bucket, pub.r2.bucket], "--public vise les deux seaux ouverts");

  // 10. Le Cache-Control et le type suivent le fichier.
  const srcO = fauxSeau("b2o", { "public/accueil.mp3": "son" });
  const recus = [];
  const dstO = fauxSeau("r2o");
  const envoi = dstO.client.send;
  dstO.client.send = (cmd) => {
    if (cmd.constructor.name === "PutObjectCommand") recus.push([cmd.input.ContentType, cmd.input.CacheControl]);
    return envoi(cmd);
  };
  const getOrig = srcO.client.send;
  srcO.client.send = async (cmd) => {
    const r = await getOrig(cmd);
    return cmd.constructor.name === "GetObjectCommand"
      ? { ...r, ContentType: "audio/mpeg", CacheControl: "public, max-age=31536000, immutable" }
      : r;
  };
  await copierTout(srcO, dstO, { journal: muet });
  v([["audio/mpeg", "public, max-age=31536000, immutable"]], recus, "type et cache d'un an recopiés");

  // 11. La sonde de l'adresse publique.
  const reponse = (status, h) => ({ status, headers: { get: (k) => h[k.toLowerCase()] ?? null } });
  const bonne = await sonderAdressePublique("https://pub-x.r2.dev/", "public/a.mp3", {
    fetchFn: async (url, init) => {
      recus.push([url, init.method, init.headers.Origin]);
      return reponse(200, { "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "https://alanyavox.com" });
    },
  });
  v(true, bonne.ok && bonne.constats.every((c) => c.startsWith("✓")), "adresse publique saine : trois ✓");
  v(["https://pub-x.r2.dev/public/a.mp3", "HEAD", "https://alanyavox.com"], recus.at(-1), "la sonde demande le bon fichier, avec l'origine du web");
  const sansCors = await sonderAdressePublique("https://p", "k", { fetchFn: async () => reponse(200, { "cache-control": "max-age=31536000" }) });
  v([true, true], [sansCors.ok, sansCors.constats[2].startsWith("✗ pas de CORS")], "CORS absent : signalé, sans bloquer");
  const fermee = await sonderAdressePublique("https://p", "k", { fetchFn: async () => reponse(401, {}) });
  v([false, 1], [fermee.ok, fermee.constats.length], "accès public fermé : échec net");

  console.log(`\n${ok} contrôles OK, ${ko} en échec`);
  return ko === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("copier-vers-r2.mjs")) {
  const args = process.argv.slice(2);
  (args.includes("--autocontrole") ? autoControle() : principal(args))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`\n✗ ${e?.message ?? e}`);
      process.exit(1);
    });
}
