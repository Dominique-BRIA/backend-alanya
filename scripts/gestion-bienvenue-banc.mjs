// Banc d'essai — bienvenue riche et multilingue (24/10/2026).
//
// Prérequis : serveur sur API_URL (défaut http://localhost:3020), base de
// développement avec le compte officiel, le super-admin de banc
// (super@banc-gestion.test) et trois comptes de langue `fr`, `zh`, `es`
// (`langue*@banc-gestion.test`, sans bienvenue reçue). Le script lit la base
// par DATABASE_URL (psql) pour vérifier les messages écrits.
//
// Usage : node --env-file=.env scripts/gestion-bienvenue-banc.mjs <image.png>
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const API = process.env.API_URL ?? "http://localhost:3020";
const IMAGE = process.argv[2];
const PSQL = process.env.PSQL ?? "C:/Program Files/PostgreSQL/18/bin/psql.exe";

let ok = 0;
let ko = 0;
const verifier = (nom, c, d = "") => (c ? (ok++, console.log(`✓ ${nom}`)) : (ko++, console.log(`✗ ${nom} ${d}`)));

async function appel(methode, chemin, { jeton, corps, formulaire } = {}) {
  const r = await fetch(`${API}/api${chemin}`, {
    method: methode,
    headers: { ...(corps ? { "Content-Type": "application/json" } : {}), ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: formulaire ?? (corps === undefined ? undefined : JSON.stringify(corps)),
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { statut: r.status, donnees: d };
}

function sql(requete) {
  const url = process.env.DATABASE_URL.replace(/\?.*$/, "");
  return execFileSync(PSQL, [url, "-At", "-c", requete], { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } }).trim();
}

const sup = await appel("POST", "/admin/auth/login", { corps: { email: "super@banc-gestion.test", password: "Banc-gestion-2026" } });
const j = sup.donnees.accessToken;

// Le média
const f = new FormData();
f.append("file", new Blob([readFileSync(IMAGE)], { type: "image/png" }), "bienvenue.png");
const envoi = await appel("POST", "/upload/media", { jeton: j, formulaire: f });
verifier("image envoyée", envoi.statut === 200 && !!envoi.donnees.url, JSON.stringify(envoi.donnees));

// Le brouillon : texte trilingue, image légendée, bouton.
const blocs = [
  { sortOrder: 0, blockType: "text", translations: { fr: "Bienvenue !", en: "Welcome!", zh: "欢迎！" } },
  { sortOrder: 1, blockType: "image", mediaUrl: envoi.donnees.url, translations: { fr: "Notre équipe", en: "Our team" } },
  {
    sortOrder: 2,
    blockType: "cta",
    ctaJson: { buttons: [{ labelFr: "Découvrir", labelEn: "Discover", action: "url", target: "https://alanyavox.com" }] },
    ctaTranslations: [{ fr: "Découvrir", en: "Discover", zh: "发现" }],
  },
];
const brouillon = await appel("PUT", "/admin/welcome/draft", { jeton: j, corps: { blocks: blocs } });
verifier("brouillon riche enregistré", brouillon.statut === 200 && brouillon.donnees.blocks?.length === 3, JSON.stringify(brouillon.donnees).slice(0, 200));
verifier("le bloc image garde son média", brouillon.donnees.blocks?.[1]?.mediaUrl === envoi.donnees.url);
verifier("le bloc bouton garde ses libellés", brouillon.donnees.blocks?.[2]?.ctaTranslations?.[0]?.zh === "发现");

const mauvaisMedia = await appel("PUT", "/admin/welcome/draft", {
  jeton: j,
  corps: { blocks: [{ blockType: "image", mediaUrl: "https://exemple.com/x.png" }] },
});
verifier("un média étranger à la console est refusé", mauvaisMedia.statut === 400 && mauvaisMedia.donnees.code === "MEDIA_NOT_FOUND");
// Le brouillon refusé n'a rien écrit : on remet le bon.
await appel("PUT", "/admin/welcome/draft", { jeton: j, corps: { blocks: blocs } });

const sansAnglais = await appel("PUT", "/admin/welcome/draft", { jeton: j, corps: { blocks: [{ blockType: "text", translations: { fr: "Seulement en français" } }] } });
verifier("un brouillon incomplet s'enregistre", sansAnglais.statut === 200);
const pubRefusee = await appel("POST", "/admin/welcome/publish", { jeton: j });
verifier("publier sans l'anglais → 400 TRANSLATION_MISSING", pubRefusee.statut === 400 && pubRefusee.donnees.code === "TRANSLATION_MISSING", JSON.stringify(pubRefusee.donnees));

await appel("PUT", "/admin/welcome/draft", { jeton: j, corps: { blocks: blocs } });
const pub = await appel("POST", "/admin/welcome/publish", { jeton: j });
verifier("publication", pub.statut === 200, JSON.stringify(pub.donnees).slice(0, 200));

// Rattrapage pour les comptes de langue.
const r = await appel("POST", "/admin/welcome/backfill", { jeton: j });
verifier("rattrapage lancé", r.statut === 200 && r.donnees.queued === true, JSON.stringify(r.donnees));
await new Promise((ok) => setTimeout(ok, 8000));

for (const [langue, attendu, legende] of [["fr", "Bienvenue !", "Notre équipe"], ["zh", "欢迎！", "Our team"], ["es", "Welcome!", "Our team"]]) {
  const lignes = sql(`
    select m.type || '|' || coalesce(m.content, '') || '|' || (select count(*) from media_files f where f."messageId" = m."msgID")
      from message m join users u on true
     where u.email = 'langue-${langue}@banc-gestion.test'
       and m."conversationID" in (select "conversID" from conv_participants where "alanyaID" = u."alanyaID")
     order by m."sendAt"`)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  verifier(`${langue} : trois messages reçus`, lignes.length === 3, JSON.stringify(lignes));
  verifier(`${langue} : texte dans sa langue (ou le repli)`, lignes[0]?.startsWith(`TEXT|${attendu}|`), lignes[0]);
  verifier(`${langue} : image avec légende et média`, lignes[1] === `IMAGE|${legende}|1`, JSON.stringify(lignes[1]));
  verifier(`${langue} : bouton en texte lisible`, (lignes[2] ?? "").startsWith("TEXT|") && lignes[2].includes("https://alanyavox.com"), lignes[2]);
  const boutons = sql(`
    select m.boutons::text from message m join users u on true
     where u.email = 'langue-${langue}@banc-gestion.test' and m.boutons is not null
       and m."conversationID" in (select "conversID" from conv_participants where "alanyaID" = u."alanyaID")`)
    .split(/\r?\n/)
    .filter(Boolean);
  const libelle = { fr: "Découvrir", zh: "发现", es: "Discover" }[langue];
  verifier(`${langue} : boutons structurés dans sa langue`, boutons.length === 1 && JSON.parse(boutons[0])[0]?.label === libelle && JSON.parse(boutons[0])[0]?.action === "url", boutons[0]);
}

console.log(`\n${ok} ✓, ${ko} ✗`);
process.exit(ko ? 1 : 0);
