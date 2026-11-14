import { decoderEntites } from "./lecture-page";

/**
 * CHERCHER SUR LE WEB POUR L'ASSISTANT ALANYA (14/11/2026).
 *
 * Interroge NOTRE moteur — SearXNG, installé sur le VPS par
 * `scripts/installer-searxng.sh` et joignable seulement depuis la machine
 * (127.0.0.1). C'est un métamoteur : il interroge lui-même plusieurs moteurs
 * publics et regroupe leurs résultats. Aucune clé, aucun quota.
 *
 * ⚠️ SON ADRESSE N'EST PAS UNE DONNÉE DU MODÈLE. Elle vient de la configuration
 * du serveur ; le modèle ne fournit que la requête.
 */

const DELAI_MS = 10_000;
export const NB_RESULTATS = 6;

export interface ResultatWeb {
  titre: string;
  lien: string;
  extrait: string;
}

export class RechercheImpossible extends Error {}

const propre = (s: unknown) =>
  decoderEntites(String(s ?? "").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** Les [NB_RESULTATS] premiers résultats pour [requete], sans doublon de lien. */
export async function rechercherWeb(requete: string, moteur: string): Promise<ResultatWeb[]> {
  const adresse = `${moteur.replace(/\/$/, "")}/search?${new URLSearchParams({
    q: requete,
    format: "json",
    language: "fr",
    safesearch: "1",
  })}`;
  let donnees: { results?: { title?: string; url?: string; content?: string }[] };
  try {
    const reponse = await fetch(adresse, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (!reponse.ok) throw new Error(`réponse ${reponse.status}`);
    donnees = await reponse.json();
  } catch (e) {
    // Le détail reste au journal : le modèle n'a besoin que de savoir que la
    // recherche n'a pas abouti, pour répondre sans elle.
    console.error(`[assistant] recherche web impossible : ${(e as Error).message}`);
    throw new RechercheImpossible("La recherche sur Internet est indisponible pour le moment.");
  }

  const vus = new Set<string>();
  const resultats: ResultatWeb[] = [];
  for (const r of donnees.results ?? []) {
    const lien = String(r.url ?? "");
    if (!/^https?:\/\//i.test(lien) || vus.has(lien)) continue;
    vus.add(lien);
    resultats.push({ titre: propre(r.title), lien, extrait: propre(r.content).slice(0, 300) });
    if (resultats.length >= NB_RESULTATS) break;
  }
  return resultats;
}
