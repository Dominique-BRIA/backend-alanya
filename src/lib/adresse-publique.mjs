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
 * Backblaze, ou le préfixe, l'une des deux copies serait corrigée et l'autre
 * oubliée : la moitié des accueils pointerait dans le vide, sans qu'aucune
 * erreur ne soit levée nulle part — un `404` chez l'appelant, et rien dans les
 * journaux du serveur. Même classe de défaut que tout le reste de ce chantier :
 * du code qui dit sans faire.
 *
 * ⚠️ IL LIT `process.env` DIRECTEMENT, et c'est volontaire : `lib/env.ts` est du
 * TypeScript, donc hors de portée de `ws-server.mjs`. Les valeurs par défaut
 * sont recopiées de `env.ts` — si tu changes l'une, change l'autre.
 */

/** Le préfixe sous lequel les fichiers ouverts sont rangés. */
function prefixe() {
  return process.env.B2_PUBLIC_KEY_PREFIX ?? "public/";
}

/** Le bucket ouvert est-il configuré ? Les trois valeurs, ou rien. */
export function bucketOuvertConfigure() {
  return Boolean(
    process.env.B2_PUBLIC_BUCKET &&
      process.env.B2_PUBLIC_KEY_ID &&
      process.env.B2_PUBLIC_APPLICATION_KEY,
  );
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
 */
export function adresseOuverte(urlRelative, espace) {
  if (espace !== "public" || !bucketOuvertConfigure()) return null;
  const hote = process.env.B2_ENDPOINT || "s3.us-west-004.backblazeb2.com";
  return `https://${process.env.B2_PUBLIC_BUCKET}.${hote}/${cleOuverte(urlRelative)}`;
}
