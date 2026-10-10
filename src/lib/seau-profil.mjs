/**
 * LE SEAU DES PHOTOS DE PROFIL — `alanyaprofile`, chez Cloudflare R2.
 *
 * Demande du user, 10/10/2026 : « implémente-le bien, pour qu'il contienne ce
 * qu'il était censé contenir ». Le seau avait été créé le 26/09 pour les photos
 * de profil (comptes ET groupes) ; il n'avait jamais été branché.
 *
 * 🔴 CE QUI CHANGE, ET CE QUI NE CHANGE PAS.
 *
 * L'adresse rangée en base NE CHANGE PAS : `https://alanyavox.com/api/avatars/<id>`.
 * La base est PARTAGÉE avec le backend de l'équipe, qui lit `users.avatar_url`
 * sans passer par nous (voir `lib/avatar.ts`) : y écrire une adresse Cloudflare
 * obligerait à migrer des données à chaque changement d'hébergeur, et casserait
 * les photos déjà en circulation dans les notifications et les caches.
 *
 * Ce qui change, c'est ce que répond cette adresse. Une photo copiée dans le
 * seau est RENVOYÉE vers lui (302) : Cloudflare sert les octets, le serveur ne
 * les transporte plus. Une photo pas encore copiée est servie comme avant — et
 * copiée au passage.
 *
 * ⚠️ UNE REDIRECTION, CETTE FOIS SANS DANGER. Le 27/09, rediriger vers une URL
 * SIGNÉE avait fait disparaître les photos : l'adresse mourait au bout d'une
 * heure, le navigateur la gardait une semaine. Ici l'adresse cible est FIXE et
 * n'expire pas : la garder en cache est exactement ce qu'on veut.
 *
 * ⚠️ IL LIT `process.env` DIRECTEMENT, comme `adresse-publique.mjs` : les scripts
 * (`scripts/avatars-profil.mjs`) doivent prendre la même décision que l'API.
 *
 * Variables (`~/backend-alanya/.env`) :
 *   STOCKAGE_PROFIL=r2            l'interrupteur ; sans lui, rien ne change
 *   R2_ENDPOINT, R2_REGION        les mêmes que le seau privé (même compte)
 *   R2_PROFIL_BUCKET              alanyaprofile
 *   R2_PROFIL_KEY_ID, R2_PROFIL_SECRET_ACCESS_KEY   un jeton limité à ce seau
 *   R2_PROFIL_URL                 l'adresse publique (https://pub-….r2.dev)
 */

/** La marque rangée dans `media_files.espace` d'une photo copiée dans le seau. */
export const ESPACE_PROFIL = "profil";

/** Le dossier des photos dans le seau. */
const PREFIXE = "avatars/";

function sansProtocole(adresse) {
  return String(adresse ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

let avertiIncomplet = false;

/**
 * Le seau des photos de profil, ou `null` s'il n'est pas branché.
 *
 * ⚠️ DEMANDÉ MAIS INCOMPLET : `null`, et on le dit une fois. Les photos restent
 * alors servies par le serveur, comme avant : rien ne casse.
 *
 * @returns {{ endpoint: string, region: string, bucket: string, keyId: string,
 *   secret: string, base: string } | null}
 */
export function cibleProfil(env = process.env) {
  if (String(env.STOCKAGE_PROFIL ?? "").trim().toLowerCase() !== "r2") return null;
  const manque = [
    "R2_ENDPOINT",
    "R2_PROFIL_BUCKET",
    "R2_PROFIL_KEY_ID",
    "R2_PROFIL_SECRET_ACCESS_KEY",
    "R2_PROFIL_URL",
  ].filter((v) => !env[v]);
  if (manque.length) {
    if (!avertiIncomplet && env === process.env) {
      avertiIncomplet = true;
      console.error(
        `[stockage] STOCKAGE_PROFIL=r2 mais ${manque.join(", ")} manque : ` +
          "les photos de profil restent servies par le serveur.",
      );
    }
    return null;
  }
  return {
    endpoint: sansProtocole(env.R2_ENDPOINT),
    region: env.R2_REGION || "auto",
    bucket: env.R2_PROFIL_BUCKET,
    keyId: env.R2_PROFIL_KEY_ID,
    secret: env.R2_PROFIL_SECRET_ACCESS_KEY,
    base: `https://${sansProtocole(env.R2_PROFIL_URL)}`,
  };
}

/** STOCKAGE_PROFIL=r2 demandé, mais une variable manque ? (point de santé) */
export function profilIncomplet(env = process.env) {
  return String(env.STOCKAGE_PROFIL ?? "").trim().toLowerCase() === "r2" && cibleProfil(env) === null;
}

/** La clé de l'objet dans le seau : `avatars/2026-10-10/<uuid>.jpg`. */
export function cleProfil(urlRelative) {
  return `${PREFIXE}${urlRelative}`.replace(/\/{2,}/g, "/");
}

/** Le chemin relatif d'origine, depuis une clé du seau — ou `null`. */
export function relatifDepuisCle(cle) {
  return typeof cle === "string" && cle.startsWith(PREFIXE) ? cle.slice(PREFIXE.length) : null;
}

/**
 * L'adresse publique et FIXE d'une photo copiée dans le seau, ou `null`.
 * Calculée à la lecture, jamais rangée : changer `R2_PROFIL_URL` (r2.dev →
 * sous-domaine) déplace toutes les photos d'un coup, sans migration.
 */
export function adresseProfil(urlRelative, env = process.env) {
  const cible = cibleProfil(env);
  return cible ? `${cible.base}/${cleProfil(urlRelative)}` : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * L'identifiant du média derrière une adresse d'avatar rangée en base, ou `null`.
 *
 * Les deux formes de `lib/avatar.ts` : `https://<hôte>/api/avatars/<id>` (depuis
 * le 06/08) et l'ancienne `/api/media/<id>`. Tout le reste — `data:`, une photo
 * hébergée par l'application de l'équipe — n'est pas à nous : `null`.
 */
export function idAvatarDepuisUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.trim().match(/(?:^|\/)api\/(?:avatars|media)\/([^/?#]+)$/);
  return m && UUID.test(m[1]) ? m[1] : null;
}
