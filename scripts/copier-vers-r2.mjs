/**
 * COPIER LE SEAU PRIVÉ DE BACKBLAZE VERS CLOUDFLARE R2 — décision du user, 10/10/2026.
 *
 * Usage, depuis le dossier du backend :
 *   node --env-file=.env scripts/copier-vers-r2.mjs --essai      compte, ne copie rien
 *   node --env-file=.env scripts/copier-vers-r2.mjs              copie ce qui manque
 *   node --env-file=.env scripts/copier-vers-r2.mjs --verifier   compare les deux seaux
 *   node --env-file=.env scripts/copier-vers-r2.mjs --inverse    R2 → Backblaze (retour arrière)
 *   node scripts/copier-vers-r2.mjs --autocontrole               contrôles hors ligne
 *
 * Source : B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY (inchangées).
 * Cible  : R2_ENDPOINT, R2_REGION (« auto »), R2_BUCKET, R2_KEY_ID, R2_SECRET_ACCESS_KEY.
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

function seauxDepuisEnv(env) {
  const manque = [];
  for (const v of ["B2_BUCKET", "B2_KEY_ID", "B2_APPLICATION_KEY", "R2_ENDPOINT", "R2_BUCKET", "R2_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    if (!env[v]) manque.push(v);
  }
  if (manque.length) throw new Error(`Variables manquantes dans .env : ${manque.join(", ")}`);
  const b2 = {
    nom: "Backblaze",
    bucket: env.B2_BUCKET,
    client: clientS3({
      endpoint: env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com",
      region: env.B2_REGION || "us-west-004",
      keyId: env.B2_KEY_ID,
      secret: env.B2_APPLICATION_KEY,
      r2: false,
    }),
  };
  const r2 = {
    nom: "Cloudflare R2",
    bucket: env.R2_BUCKET,
    client: clientS3({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      keyId: env.R2_KEY_ID,
      secret: env.R2_SECRET_ACCESS_KEY,
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

/* ─────────────────────────────── Programme */

const mo = (n) => `${(n / 1024 / 1024).toFixed(1)} Mo`;

async function principal(args) {
  const { b2, r2 } = seauxDepuisEnv(process.env);
  const inverse = args.includes("--inverse");
  const [source, cible] = inverse ? [r2, b2] : [b2, r2];
  const avecSauvegardes = args.includes("--avec-sauvegardes");

  console.log(`\nDe ${source.nom} (${source.bucket}) vers ${cible.nom} (${cible.bucket})`);
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
    const ok = v.manquants.length === 0 && v.differents.length === 0;
    console.log(ok ? "\n✓ Les deux seaux concordent." : "\n✗ Relancer la copie (sans option), puis vérifier de nouveau.");
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
