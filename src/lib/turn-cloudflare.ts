import { env } from "@/lib/env";

/**
 * LE TURN DE CLOUDFLARE, EN PREMIER CHOIX (03/11/2026, décision du user).
 *
 * Cloudflare fournit des relais TURN sur son réseau mondial, au plus près de
 * chaque téléphone. Nos relais coturn (`turn.kemita.eu`, `turn.alanya226.com`)
 * RESTENT dans la liste, derrière : si Cloudflare ne passe pas, l'appel bascule
 * sur eux.
 *
 * ⚠️ LA BASCULE SE FAIT À DEUX ENDROITS, ET C'EST VOULU :
 *  - ICI, si l'API de Cloudflare ne répond pas (panne, jeton refusé, délai) :
 *    `/api/calls/ice` ne rend que nos relais, et l'appel se fait sans attendre ;
 *  - DANS LE TÉLÉPHONE, si les relais de Cloudflare sont injoignables depuis son
 *    réseau : WebRTC essaie TOUS les serveurs de la liste en même temps et
 *    retient la première paire qui marche. Aucune logique de plus n'est
 *    nécessaire côté client.
 *
 * Les identifiants Cloudflare sont temporaires : demandés pour 24 h, et gardés
 * en mémoire 12 h au plus — tout client qui les reçoit en a donc encore 12 h
 * devant lui, plus que n'importe quel appel. Un échec de l'API est retenu une
 * minute, pour ne pas la solliciter à chaque appel quand elle est en panne.
 *
 * Variables : `CLOUDFLARE_TURN_ID` (l'identifiant de la clé TURN) et
 * `CLOUDFLARE_TURN_API_TOKEN` (son jeton d'API). Absentes = Cloudflare n'est
 * pas utilisé, et rien d'autre ne change.
 */

export type ServeurIce = { urls: string[]; username?: string; credential?: string };

const DUREE_IDENTIFIANTS_S = 24 * 3600;
const REUTILISATION_MS = 12 * 3600 * 1000;
const PAUSE_APRES_ECHEC_MS = 60 * 1000;
const DELAI_API_MS = 3000;

let enCache: { serveurs: ServeurIce[]; jusqua: number } | null = null;
let echecJusqua = 0;
let enCours: Promise<ServeurIce[]> | null = null;

/** Cloudflare est-il configuré ? */
export function cloudflareConfigure(): boolean {
  return !!(env.cloudflareTurn.keyId() && env.cloudflareTurn.apiToken());
}

/**
 * Le port 53 est bloqué par les navigateurs (documentation de Cloudflare) :
 * l'URL attendrait son délai pour rien. On l'écarte partout.
 */
function nettoyer(brut: unknown): ServeurIce[] {
  const liste = Array.isArray(brut) ? brut : brut ? [brut] : [];
  const out: ServeurIce[] = [];
  for (const s of liste) {
    if (!s || typeof s !== "object") continue;
    const e = s as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter(
      (u): u is string => typeof u === "string" && !/:53(\?|$)/.test(u),
    );
    if (urls.length === 0) continue;
    out.push({
      urls,
      ...(typeof e.username === "string" ? { username: e.username } : {}),
      ...(typeof e.credential === "string" ? { credential: e.credential } : {}),
    });
  }
  return out;
}

/** Les serveurs ICE de Cloudflare, ou `[]` s'il n'est pas configuré ou ne répond pas. */
export async function serveursCloudflare(): Promise<ServeurIce[]> {
  const id = env.cloudflareTurn.keyId();
  const jeton = env.cloudflareTurn.apiToken();
  if (!id || !jeton) return [];
  const maintenant = Date.now();
  if (enCache && enCache.jusqua > maintenant) return enCache.serveurs;
  if (echecJusqua > maintenant) return [];

  enCours ??= (async () => {
    const arret = new AbortController();
    const minuteur = setTimeout(() => arret.abort(), DELAI_API_MS);
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: DUREE_IDENTIFIANTS_S }),
          signal: arret.signal,
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const serveurs = nettoyer(((await r.json()) as { iceServers?: unknown })?.iceServers);
      if (serveurs.length === 0) throw new Error("réponse sans serveur");
      enCache = { serveurs, jusqua: Date.now() + REUTILISATION_MS };
      return serveurs;
    } catch (e) {
      // Jamais le jeton dans le journal : seulement la nature de l'échec.
      console.warn(`[ICE] Cloudflare indisponible, relais coturn seuls : ${(e as Error).message}`);
      echecJusqua = Date.now() + PAUSE_APRES_ECHEC_MS;
      return [];
    } finally {
      clearTimeout(minuteur);
      enCours = null;
    }
  })();
  return enCours;
}
