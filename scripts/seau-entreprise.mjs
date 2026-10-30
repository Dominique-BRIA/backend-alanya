/**
 * LE SEAU ENTREPRISE : VOIR CE QU'IL CONTIENT, ET Y POSER SES DEUX ESPACES.
 *
 * Usage, depuis le dossier du backend :
 *   node --env-file=.env scripts/seau-entreprise.mjs --etat
 *   node --env-file=.env scripts/seau-entreprise.mjs --etat --seau=<nom>
 *   node --env-file=.env scripts/seau-entreprise.mjs --creer --seau=<nom>
 *   node scripts/seau-entreprise.mjs --autocontrole        (hors ligne, sans clés)
 *
 * 🔴 POURQUOI UN OUTIL PLUTÔT QUE LE TABLEAU DE BORD (27/10/2026). Le user n'a
 * pas pu ouvrir la console Cloudflare : la vérification anti-robot de l'écran de
 * connexion échoue chez lui. Or les clés R2 sont déjà sur le serveur, et l'API
 * S3 fait tout ce dont on a besoin ici. `--etat` donne même LE NOM EXACT du
 * seau, qu'on ne pouvait pas lire autrement.
 *
 * ⚠️ IL N'Y A PAS DE DOSSIER À CRÉER, ET `--creer` NE PRÉTEND PAS LE FAIRE. Un
 * dossier R2 n'est qu'un préfixe de nom : il paraît au premier objet déposé et
 * disparaît avec le dernier. `--creer` dépose donc un objet témoin dans chacun
 * des deux espaces, pour qu'ils soient VISIBLES dans le tableau de bord avant
 * que le premier vrai fichier n'arrive. Le témoin pourra être effacé ensuite.
 *
 * Variables lues : R2_ENDPOINT, et les clés — `R2_ENTREPRISE_KEY_ID` /
 * `R2_ENTREPRISE_SECRET_ACCESS_KEY` si elles existent, sinon celles du seau
 * privé (`R2_KEY_ID` / `R2_SECRET_ACCESS_KEY`), qui suffisent quand le jeton
 * porte sur tout le compte. Le seau : `--seau=<nom>` ou `R2_ENTREPRISE_BUCKET`.
 */
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { ESPACES, cleAutorisee } from "../src/lib/seau-entreprise.mjs";

const args = process.argv.slice(2);
const a = (nom) => args.includes(nom);
const valeur = (nom) => {
  const trouve = args.find((x) => x.startsWith(`${nom}=`));
  return trouve ? trouve.slice(nom.length + 1) : null;
};

const TEMOIN = `Espace créé le ${new Date().toISOString().slice(0, 10)} par scripts/seau-entreprise.mjs.
R2 n'a pas de dossiers : ce fichier existe pour que le préfixe soit visible.
Il peut être effacé dès que de vrais fichiers sont arrivés.
`;

function sansProtocole(url) {
  return String(url ?? "").replace(/^https?:\/\//, "");
}

function client(env) {
  const endpoint = env.R2_ENDPOINT;
  const keyId = env.R2_ENTREPRISE_KEY_ID || env.R2_KEY_ID;
  const secret = env.R2_ENTREPRISE_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !keyId || !secret) {
    throw new Error(
      "Clés absentes. Il faut R2_ENDPOINT, et R2_ENTREPRISE_KEY_ID/R2_ENTREPRISE_SECRET_ACCESS_KEY " +
        "(ou à défaut R2_KEY_ID/R2_SECRET_ACCESS_KEY). Lance avec --env-file=.env.",
    );
  }
  return new S3Client({
    endpoint: `https://${sansProtocole(endpoint)}`,
    region: env.R2_REGION || "auto",
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    forcePathStyle: false,
    // R2 refuse les sommes de contrôle que le SDK ajoute d'office.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function etat(s3, seau) {
  console.log("── Les seaux que ces clés voient ──");
  try {
    const r = await s3.send(new ListBucketsCommand({}));
    const seaux = r.Buckets ?? [];
    if (seaux.length === 0) console.log("  (aucun — le jeton ne porte probablement que sur UN seau)");
    for (const b of seaux) console.log(`  · ${b.Name}`);
  } catch (e) {
    console.log(`  (liste refusée : ${e.name} — un jeton limité à un seul seau ne peut pas lister)`);
  }

  if (!seau) {
    console.log("\nAucun seau nommé : ajoute --seau=<nom> ou R2_ENTREPRISE_BUCKET pour aller plus loin.");
    return;
  }

  console.log(`\n── Ce que contient « ${seau} », au premier niveau ──`);
  const r = await s3.send(new ListObjectsV2Command({ Bucket: seau, Delimiter: "/", MaxKeys: 1000 }));
  const prefixes = (r.CommonPrefixes ?? []).map((p) => p.Prefix);
  const aLaRacine = (r.Contents ?? []).filter((o) => !o.Key.includes("/"));
  if (prefixes.length === 0 && aLaRacine.length === 0) console.log("  (vide)");
  for (const p of prefixes) console.log(`  📁 ${p}`);
  for (const o of aLaRacine) console.log(`  📄 ${o.Key}  (${o.Size} o)`);

  console.log("\n── Les deux espaces attendus ──");
  for (const espace of ESPACES) {
    const present = prefixes.includes(`${espace}/`);
    console.log(`  ${present ? "✅" : "⬜"} ${espace}/`);
  }
}

async function creer(s3, seau) {
  if (!seau) throw new Error("Il faut nommer le seau : --seau=<nom>");
  for (const espace of ESPACES) {
    const cle = `${espace}/.espace-alanya.txt`;
    if (!cleAutorisee(cle)) throw new Error(`Refus : « ${cle} » sort des deux espaces.`);
    await s3.send(
      new PutObjectCommand({
        Bucket: seau,
        Key: cle,
        Body: TEMOIN,
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    console.log(`  ✅ ${cle}`);
  }
  console.log("\nLes deux espaces sont visibles. Relance avec --etat pour le vérifier.");
}

function autocontrole() {
  const essais = [
    ["deux espaces, pas trois", ESPACES.length, 2],
    ["call-center en premier", ESPACES[0], "call-center"],
    ["archives en second", ESPACES[1], "archives"],
    ["un témoin est dans l'espace", cleAutorisee("call-center/.espace-alanya.txt"), true],
    ["la racine est refusée", cleAutorisee(".espace-alanya.txt"), false],
    ["un espace inventé est refusé", cleAutorisee("rapports/x.pdf"), false],
    ["l'endpoint perd son protocole", sansProtocole("https://abc.r2.cloudflarestorage.com"), "abc.r2.cloudflarestorage.com"],
  ];
  let ko = 0;
  for (const [nom, obtenu, attendu] of essais) {
    const ok = obtenu === attendu;
    if (!ok) ko++;
    console.log(`  ${ok ? "✅" : "❌"} ${nom}${ok ? "" : `  → ${JSON.stringify(obtenu)} au lieu de ${JSON.stringify(attendu)}`}`);
  }
  console.log(ko === 0 ? "\nAutocontrôle : tout tient." : `\n${ko} contrôle(s) en échec`);
  return ko;
}

async function principal() {
  if (a("--autocontrole")) process.exit(autocontrole() === 0 ? 0 : 1);

  const seau = valeur("--seau") || process.env.R2_ENTREPRISE_BUCKET || null;
  const s3 = client(process.env);
  if (a("--creer")) await creer(s3, seau);
  else await etat(s3, seau);
}

principal().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
