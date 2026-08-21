import { env } from "@/lib/env";

/**
 * Les adresses ABSOLUES écrites en base pour la plateforme de l'équipe.
 *
 * 🔴 POURQUOI ELLES SONT ÉCRITES ET NON CALCULÉES À LA LECTURE. La plateforme
 * lit nos tables DIRECTEMENT — comme elle le fait déjà pour `center_music` et
 * `center_audio` — et doit y trouver une adresse prête à l'emploi, sans avoir à
 * connaître notre schéma d'URL ni à le reconstruire. Le jour où le domaine
 * change, c'est un `UPDATE` chez nous, pas une correction chez elle.
 *
 * ⚠️ **UN SEUL ENDROIT OÙ LE DOMAINE EST ÉCRIT.** Il vivait en trois copies —
 * `urlPublique` dans `ivr.mjs`, `urlPubliquePlainte` dans la route des plaintes,
 * et `env.publicBaseUrl` qui existait déjà et que les deux ignoraient. Deux
 * endroits finissent toujours par diverger ; celui-ci fait foi pour les URL
 * publiques bâties en TypeScript.
 *
 * ⚠️ `PUBLIC_BASE_URL` **n'est pas posée dans le `.env` du VPS** (vérifié le
 * 21/08/2026) : c'est donc le repli `https://alanyavox.com` d'`env.ts` qui sert,
 * et les six plaintes déjà en base portent une URL bâtie ainsi. Ça marche, mais
 * un changement de domaine se ferait alors dans le CODE. Poser la variable est
 * le vrai correctif, et il ne change aucune valeur existante.
 */
function base(): string {
  return env.publicBaseUrl;
}

/** L'audio d'une plainte vocale, lisible sans jeton. */
export function urlPubliquePlainte(idComplaint: string): string {
  return `${base()}/api/public/plaintes/${idComplaint}/audio`;
}

/**
 * L'enregistrement MÉLANGÉ d'une conversation agent ↔ client, lisible sans
 * jeton.
 *
 * ⚠️ L'identifiant est celui de l'ENREGISTREMENT, jamais celui du média :
 * exposer `media_files.id` ouvrirait un second chemin vers tous les médias du
 * produit dès qu'un identifiant fuiterait.
 */
export function urlPubliqueEnregistrement(idRecording: string): string {
  return `${base()}/api/public/enregistrements/${idRecording}/audio`;
}
