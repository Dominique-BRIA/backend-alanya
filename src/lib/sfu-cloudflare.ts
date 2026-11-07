import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";

/**
 * LE SFU DE CLOUDFLARE (Realtime SFU), POUR LES GROUPES ET LES RÉUNIONS
 * (07/11/2026).
 *
 * En mesh, chaque participant ouvre une connexion vers chacun des autres et
 * encode son image autant de fois : le coût croît avec l'assemblée, pour
 * chacun. Avec le SFU, chaque participant n'a qu'UNE connexion, vers
 * Cloudflare : il y PUBLIE ses pistes (micro, caméra) une fois, et RECOIT
 * celles des autres, que Cloudflare redistribue.
 *
 * 🔴 LE JETON DE L'APPLICATION NE QUITTE JAMAIS LE SERVEUR. Les téléphones et
 * les navigateurs passent par nos routes (`/api/sfu/...`), qui vérifient
 * d'abord que l'appelant est bien dans la salle, puis parlent à Cloudflare.
 *
 * L'API (https://developers.cloudflare.com/realtime/sfu/) :
 *  - `POST /sessions/new` → une session (une connexion WebRTC) ;
 *  - `POST /sessions/:id/tracks/new` → publier des pistes locales (offre du
 *    client, réponse de Cloudflare), ou demander des pistes distantes
 *    (Cloudflare rend alors SON offre, à laquelle le client répond) ;
 *  - `PUT /sessions/:id/renegotiate` → la réponse du client à cette offre ;
 *  - `PUT /sessions/:id/tracks/close` → ne plus recevoir des pistes.
 *
 * Variables : `CLOUDFLARE_SFU_APP_ID` et `CLOUDFLARE_SFU_APP_TOKEN`.
 */

const DELAI_MS = 8000;

export type Description = { type: "offer" | "answer"; sdp: string };

type PisteCloudflare = {
  location?: "local" | "remote";
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};

type ReponseCloudflare = {
  sessionId?: string;
  sessionDescription?: Description;
  tracks?: PisteCloudflare[];
  requiresImmediateRenegotiation?: boolean;
  errorCode?: string;
  errorDescription?: string;
};

/** Le SFU est-il configuré sur ce serveur ? */
export function sfuConfigure(): boolean {
  return !!(env.cloudflareSfu.appId() && env.cloudflareSfu.appToken());
}

async function appeler(methode: "GET" | "POST" | "PUT", chemin: string, corps?: unknown): Promise<ReponseCloudflare> {
  const appId = env.cloudflareSfu.appId();
  const jeton = env.cloudflareSfu.appToken();
  if (!appId || !jeton) throw new HttpError(503, "Le SFU n'est pas configuré", "SFU_NON_CONFIGURE");

  const arret = new AbortController();
  const minuteur = setTimeout(() => arret.abort(), DELAI_MS);
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}${chemin}`, {
      method: methode,
      headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
      body: corps === undefined ? undefined : JSON.stringify(corps),
      signal: arret.signal,
      cache: "no-store",
    });
    const donnees = ((await r.json().catch(() => ({}))) ?? {}) as ReponseCloudflare;
    if (!r.ok || donnees.errorCode) {
      // Jamais le jeton dans le journal : le code et la description de Cloudflare.
      console.warn(
        `[SFU] ${methode} ${chemin.replace(/sessions\/[^/]+/, "sessions/…")} → HTTP ${r.status} ${donnees.errorCode ?? ""} ${donnees.errorDescription ?? ""}`,
      );
      throw new HttpError(502, "Le SFU a refusé la demande", "SFU_REFUS");
    }
    return donnees;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.warn(`[SFU] ${methode} injoignable : ${(e as Error).message}`);
    throw new HttpError(502, "Le SFU est injoignable", "SFU_INJOIGNABLE");
  } finally {
    clearTimeout(minuteur);
  }
}

/** Ouvre une session chez Cloudflare. */
export async function creerSession(): Promise<string> {
  const r = await appeler("POST", "/sessions/new");
  if (!r.sessionId) throw new HttpError(502, "Le SFU n'a pas ouvert de session", "SFU_REFUS");
  return r.sessionId;
}

/**
 * Publie des pistes locales : [offre] est celle du client, Cloudflare rend sa
 * réponse. [pistes] associe chaque `mid` de l'offre à un nom de piste.
 */
export async function publierPistes(
  sessionId: string,
  offre: Description,
  pistes: { mid: string; nom: string }[],
): Promise<{ reponse: Description; pistes: { mid: string; nom: string; erreur: string | null }[] }> {
  const r = await appeler("POST", `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
    sessionDescription: offre,
    tracks: pistes.map((p) => ({ location: "local", mid: p.mid, trackName: p.nom })),
  });
  if (!r.sessionDescription) throw new HttpError(502, "Le SFU n'a pas répondu à l'offre", "SFU_REFUS");
  return {
    reponse: r.sessionDescription,
    pistes: (r.tracks ?? []).map((t) => ({
      mid: t.mid ?? "",
      nom: t.trackName ?? "",
      erreur: t.errorCode ?? null,
    })),
  };
}

/**
 * Demande à recevoir des pistes publiées par d'autres sessions. Cloudflare
 * rend une OFFRE quand il faut renégocier ; le client y répond par
 * [renegocier]. Chaque piste revient avec le `mid` sous lequel elle arrivera.
 */
export async function recevoirPistes(
  sessionId: string,
  pistes: { sessionId: string; nom: string }[],
): Promise<{
  offre: Description | null;
  pistes: { mid: string; sessionId: string; nom: string; erreur: string | null }[];
}> {
  const r = await appeler("POST", `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
    tracks: pistes.map((p) => ({ location: "remote", sessionId: p.sessionId, trackName: p.nom })),
  });
  return {
    offre: r.requiresImmediateRenegotiation && r.sessionDescription ? r.sessionDescription : null,
    pistes: (r.tracks ?? []).map((t) => ({
      mid: t.mid ?? "",
      sessionId: t.sessionId ?? "",
      nom: t.trackName ?? "",
      erreur: t.errorCode ?? null,
    })),
  };
}

/** La réponse du client à l'offre rendue par [recevoirPistes]. */
export async function renegocier(sessionId: string, reponse: Description): Promise<void> {
  await appeler("PUT", `/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
    sessionDescription: reponse,
  });
}

/**
 * Cesse de recevoir les pistes [mids] (un participant est parti). Cloudflare
 * peut rendre une offre : le client y répond par [renegocier].
 */
export async function fermerPistes(sessionId: string, mids: string[]): Promise<{ offre: Description | null }> {
  if (mids.length === 0) return { offre: null };
  const r = await appeler("PUT", `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
    tracks: mids.map((mid) => ({ mid })),
    force: true,
  });
  return {
    offre: r.requiresImmediateRenegotiation && r.sessionDescription ? r.sessionDescription : null,
  };
}
