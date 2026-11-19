// LES APPELS ENTRANTS VERS LES iPHONE (19/11/2026) : notification VoIP
// (PushKit), envoyée DIRECTEMENT aux serveurs d'Apple — Firebase ne sait pas
// les transporter.
//
// HTTP/2 et jeton JWT signé ES256 par la clé `.p8` d'Apple : `node:http2` et
// `node:crypto` suffisent, aucune dépendance de plus.
//
// Réglages (.env) — tant qu'ils manquent, rien ne part et rien ne casse :
//   APNS_TEAM_ID        identifiant d'équipe Apple (10 caractères)
//   APNS_KEY_ID         identifiant de la clé .p8
//   APNS_CLE_P8         contenu de la clé (« \n » accepté pour les retours)
//   APNS_CLE_P8_CHEMIN  … ou le chemin du fichier .p8
//   APNS_BUNDLE_ID      com.alanya237.work par défaut
//   APNS_SANDBOX=1      versions de développement (Xcode) ; TestFlight et
//                       App Store passent par la production
//
// 🔴 RÈGLE D'APPLE : chaque notification VoIP fait déclarer un appel à
// CallKit par le téléphone. N'envoyer par ici QUE des appels entrants —
// jamais une annulation ni autre chose.

import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";

const HOTE_PRODUCTION = "https://api.push.apple.com";
const HOTE_DEVELOPPEMENT = "https://api.sandbox.push.apple.com";

function lireConfig() {
  const equipe = process.env.APNS_TEAM_ID?.trim();
  const cleId = process.env.APNS_KEY_ID?.trim();
  let cle = process.env.APNS_CLE_P8?.replace(/\\n/g, "\n").trim();
  if (!cle && process.env.APNS_CLE_P8_CHEMIN) {
    try {
      cle = fs.readFileSync(process.env.APNS_CLE_P8_CHEMIN.trim(), "utf8").trim();
    } catch {
      cle = "";
    }
  }
  if (!equipe || !cleId || !cle) return null;
  return {
    equipe,
    cleId,
    cle,
    bundle: process.env.APNS_BUNDLE_ID?.trim() || "com.alanya237.work",
    hote: process.env.APNS_SANDBOX === "1" ? HOTE_DEVELOPPEMENT : HOTE_PRODUCTION,
  };
}

/** Les réglages Apple sont-ils en place ? */
export function voipConfigure() {
  return lireConfig() !== null;
}

const base64url = (texte) => Buffer.from(texte).toString("base64url");

/** Apple accepte un même jeton JWT une heure ; on le renouvelle à 50 min. */
let jwtEnCache = null;

function jetonJwt(config) {
  const maintenant = Math.floor(Date.now() / 1000);
  if (jwtEnCache && jwtEnCache.cleId === config.cleId && maintenant - jwtEnCache.emis < 50 * 60) {
    return jwtEnCache.valeur;
  }
  const entete = base64url(JSON.stringify({ alg: "ES256", kid: config.cleId }));
  const corps = base64url(JSON.stringify({ iss: config.equipe, iat: maintenant }));
  const signature = crypto.sign("sha256", Buffer.from(`${entete}.${corps}`), {
    key: config.cle,
    dsaEncoding: "ieee-p1363",
  });
  const valeur = `${entete}.${corps}.${signature.toString("base64url")}`;
  jwtEnCache = { valeur, emis: maintenant, cleId: config.cleId };
  return valeur;
}

/** Une connexion HTTP/2 gardée ouverte, comme Apple le recommande. */
let session = null;
let sessionHote = null;
let enCours = 0;

function obtenirSession(hote) {
  if (session && !session.closed && !session.destroyed && sessionHote === hote) return session;
  const s = http2.connect(hote);
  s.on("error", () => {
    if (session === s) session = null;
  });
  s.on("goaway", () => {
    if (session === s) session = null;
  });
  s.on("close", () => {
    if (session === s) session = null;
  });
  session = s;
  sessionHote = hote;
  return s;
}

function envoyerUn(config, jeton, corps, expiration) {
  return new Promise((resoudre) => {
    let s;
    try {
      s = obtenirSession(config.hote);
    } catch (e) {
      resoudre({ statut: 0, raison: e.message });
      return;
    }
    let fini = false;
    // La connexion reste ouverte pour les appels suivants, mais ne retient
    // pas un processus qui n'a plus rien à faire (un banc) : retenue pendant
    // la requête seulement.
    enCours++;
    s.ref?.();
    const finir = (r) => {
      if (fini) return;
      fini = true;
      enCours--;
      if (enCours === 0) s.unref?.();
      resoudre(r);
    };
    let requete;
    try {
      requete = s.request({
        ":method": "POST",
        ":path": `/3/device/${jeton}`,
        authorization: `bearer ${jetonJwt(config)}`,
        "apns-topic": `${config.bundle}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": String(expiration),
        "content-type": "application/json",
      });
    } catch (e) {
      finir({ statut: 0, raison: e.message });
      return;
    }
    let statut = 0;
    let reponse = "";
    requete.setTimeout(10_000, () => {
      requete.close();
      finir({ statut: 0, raison: "délai dépassé" });
    });
    requete.on("response", (entetes) => {
      statut = Number(entetes[":status"]) || 0;
    });
    requete.on("data", (morceau) => {
      reponse += morceau;
    });
    requete.on("end", () => {
      let raison = "";
      try {
        raison = JSON.parse(reponse).reason ?? "";
      } catch {}
      finir({ statut, raison });
    });
    requete.on("error", (e) => finir({ statut: 0, raison: e.message }));
    requete.end(JSON.stringify(corps));
  });
}

/**
 * Envoie [charge] (les champs de l'appel, à plat) à chaque jeton VoIP.
 * Rend le nombre de jetons servis et ceux qu'Apple déclare morts (410 :
 * application désinstallée ou jeton remplacé), à effacer.
 * Ne lève jamais.
 */
export async function envoyerVoip(jetons, charge, { ttlMs = 90_000 } = {}) {
  const config = lireConfig();
  if (!config || jetons.length === 0) return { servis: 0, morts: [], refus: [] };
  const expiration = Math.floor(Date.now() / 1000) + Math.floor(ttlMs / 1000);
  const corps = { aps: {}, ...charge };
  const resultats = await Promise.all(jetons.map((j) => envoyerUn(config, j, corps, expiration)));
  let servis = 0;
  const morts = [];
  const refus = [];
  resultats.forEach((r, i) => {
    if (r.statut === 200) servis++;
    else if (r.statut === 410 || r.raison === "Unregistered") morts.push(jetons[i]);
    else {
      refus.push(r);
      console.warn(`[voip] refus APNs ${r.statut} ${r.raison}`);
    }
  });
  return { servis, morts, refus };
}
