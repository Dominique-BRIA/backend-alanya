/**
 * L'ADRESSE D'UN FICHIER DU BUCKET OUVERT — UNE SEULE RÈGLE, UN SEUL ENDROIT.
 *
 * 🔴 POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST EN `.mjs`.
 *
 * Deux mondes ont besoin de fabriquer cette adresse : les routes Next (en
 * TypeScript, via `modules/media/b2-public.ts`) et `ws-server.mjs`, qui est un
 * processus séparé et ne peut pas importer de TypeScript. Sans ce module
 * partagé, la règle serait écrite DEUX FOIS.
 *
 * ⚠️ ET DEUX FOIS, C'EST UNE FOIS DE TROP. Le jour où l'on change de région
 * Backblaze, d'hébergeur, ou le préfixe, l'une des deux copies serait corrigée et l'autre
 * oubliée : la moitié des accueils pointerait dans le vide, sans qu'aucune
 * erreur ne soit levée nulle part — un `404` chez l'appelant, et rien dans les
 * journaux du serveur. Même classe de défaut que tout le reste de ce chantier :
 * du code qui dit sans faire.
 *
 * ⚠️ IL LIT `process.env` DIRECTEMENT, et c'est volontaire : `lib/env.ts` est du
 * TypeScript, donc hors de portée de `ws-server.mjs`. Les valeurs par défaut
 * sont recopiées de `env.ts` — si tu changes l'une, change l'autre.
 */

/** Le préfixe sous lequel les fichiers ouverts sont rangés — le même chez les deux hébergeurs. */
function prefixe() {
  return process.env.B2_PUBLIC_KEY_PREFIX ?? "public/";
}

function sansProtocole(adresse) {
  return String(adresse ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** `pub-xxx.r2.dev`, `https://pub-xxx.r2.dev/` → `https://pub-xxx.r2.dev`. */
function basePublique(adresse) {
  const a = sansProtocole(adresse);
  return a ? `https://${a}` : "";
}

let avertiR2Incomplet = false;

/**
 * OÙ VIT LE SEAU OUVERT : Backblaze (défaut) ou Cloudflare R2 — ou nulle part.
 *
 * 🔴 10/10/2026 : `STOCKAGE_PUBLIC=r2` le fait passer chez Cloudflare R2, comme
 * `STOCKAGE_PRIVE=r2` l'a fait pour le seau privé. La décision est prise ICI,
 * une seule fois, parce que l'API (`modules/media/b2-public.ts`) et
 * `ws-server.mjs` doivent tomber d'accord : un fichier écrit chez R2 et annoncé
 * à une adresse Backblaze, c'est un accueil qui ne joue pas — sans erreur nulle
 * part.
 *
 * ⚠️ CHEZ R2, L'ADRESSE PUBLIQUE N'EST PAS DÉDUCTIBLE DU NOM DU SEAU. Backblaze
 * sert `https://<seau>.<endpoint>/…` ; R2 sert soit `https://pub-<hash>.r2.dev`,
 * soit un domaine à nous. D'où `R2_PUBLIC_URL`, obligatoire : passer de
 * `r2.dev` à un sous-domaine plus tard ne demandera que de changer cette ligne.
 *
 * ⚠️ R2 DEMANDÉ MAIS INCOMPLET : on reste chez Backblaze, et on le dit une fois.
 * Basculer vers une configuration à moitié remplie casserait chaque accueil.
 *
 * Rend `null` quand aucun seau ouvert n'est configuré : tout retombe alors dans
 * le seau privé, et le répondeur marche — un peu plus lentement.
 *
 * @returns {{ fournisseur: "b2" | "r2", endpoint: string, region: string, bucket: string,
 *   keyId: string, secret: string, base: string } | null}
 */
export function cibleOuverte(env = process.env) {
  const r2Demande = String(env.STOCKAGE_PUBLIC ?? "b2").trim().toLowerCase() === "r2";
  const r2Complet = Boolean(
    env.R2_ENDPOINT &&
      env.R2_PUBLIC_BUCKET &&
      env.R2_PUBLIC_KEY_ID &&
      env.R2_PUBLIC_SECRET_ACCESS_KEY &&
      env.R2_PUBLIC_URL,
  );
  if (r2Demande && r2Complet) {
    return {
      fournisseur: "r2",
      endpoint: sansProtocole(env.R2_ENDPOINT),
      region: env.R2_REGION || "auto",
      bucket: env.R2_PUBLIC_BUCKET,
      keyId: env.R2_PUBLIC_KEY_ID,
      secret: env.R2_PUBLIC_SECRET_ACCESS_KEY,
      base: basePublique(env.R2_PUBLIC_URL),
    };
  }
  if (r2Demande && !avertiR2Incomplet && env === process.env) {
    avertiR2Incomplet = true;
    console.error(
      "[stockage] STOCKAGE_PUBLIC=r2 mais R2_ENDPOINT, R2_PUBLIC_BUCKET, R2_PUBLIC_KEY_ID, " +
        "R2_PUBLIC_SECRET_ACCESS_KEY ou R2_PUBLIC_URL manque : le seau ouvert reste chez Backblaze.",
    );
  }
  if (!(env.B2_PUBLIC_BUCKET && env.B2_PUBLIC_KEY_ID && env.B2_PUBLIC_APPLICATION_KEY)) return null;
  const endpoint = sansProtocole(env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com");
  return {
    fournisseur: "b2",
    endpoint,
    region: env.B2_REGION || "us-west-004",
    bucket: env.B2_PUBLIC_BUCKET,
    keyId: env.B2_PUBLIC_KEY_ID,
    secret: env.B2_PUBLIC_APPLICATION_KEY,
    base: `https://${env.B2_PUBLIC_BUCKET}.${endpoint}`,
  };
}

/** R2 a-t-il été demandé pour le seau ouvert sans être complet ? (point de santé) */
export function r2OuvertIncomplet(env = process.env) {
  return (
    String(env.STOCKAGE_PUBLIC ?? "b2").trim().toLowerCase() === "r2" &&
    cibleOuverte(env)?.fournisseur !== "r2"
  );
}

/** Le bucket ouvert est-il configuré, chez l'un ou l'autre hébergeur ? */
export function bucketOuvertConfigure() {
  return cibleOuverte() !== null;
}

/** La clé de l'objet dans le bucket ouvert. */
export function cleOuverte(urlRelative) {
  return `${prefixe()}${urlRelative}`.replace(/\/{2,}/g, "/");
}

/**
 * L'adresse publique et STABLE d'un fichier ouvert, ou `null`.
 *
 * 🔴 ELLE NE CHANGE JAMAIS, ne porte aucun jeton et n'expire pas : le
 * navigateur la met en cache, et un accueil déjà entendu ne se retélécharge
 * pas. Une URL signée, elle, change à chaque demande — un cache ne peut rien
 * en faire.
 *
 * ⚠️ REND `null` PLUTÔT QU'UNE ADRESSE BANCALE quand le bucket n'est pas
 * configuré. Une adresse construite sur un bucket vide donnerait
 * `https://undefined.s3…` — une panne qui ne ressemble pas à sa cause.
 *
 * ⚠️ ELLE EST CALCULÉE À LA LECTURE, jamais rangée en base : changer
 * d'hébergeur change toutes les adresses d'un coup, sans migration.
 */
export function adresseOuverte(urlRelative, espace) {
  if (espace !== "public") return null;
  const cible = cibleOuverte();
  return cible ? `${cible.base}/${cleOuverte(urlRelative)}` : null;
}
