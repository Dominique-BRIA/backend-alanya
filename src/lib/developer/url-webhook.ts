import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * L'ADRESSE D'UN WEBHOOK NE DOIT VISER QUE L'INTERNET PUBLIC (07/11/2026).
 *
 * 🔴 LE DÉFAUT CORRIGÉ. N'importe quelle URL http(s) était acceptée, et notre
 * serveur y envoyait un POST à chaque message. `http://127.0.0.1:3001/…`,
 * une adresse du réseau privé ou `169.254.169.254` (où beaucoup d'hébergeurs
 * servent la configuration de la machine) faisaient donc de notre serveur un
 * relais vers notre propre réseau — et n'importe qui peut créer un projet.
 *
 * Trois règles, celles des services de webhooks établis :
 *  1. **https seulement.** Un récepteur de webhook est un service en ligne ;
 *     les outils de test (ngrok, etc.) donnent tous une adresse https.
 *  2. **Le NOM est résolu, et chaque adresse obtenue est contrôlée.** Vérifier
 *     le texte de l'URL ne suffit pas : `interne.exemple.com` peut pointer sur
 *     10.0.0.5. Les écritures détournées (`[::ffff:127.0.0.1]`, `0x7f.1`…)
 *     sont normalisées par l'analyseur d'URL et par le résolveur.
 *  3. **Le contrôle est refait à chaque envoi**, pas seulement à
 *     l'enregistrement : un nom qui pointait ailleurs hier peut viser notre
 *     réseau aujourd'hui (« DNS rebinding »). Il reste une fenêtre entre le
 *     contrôle et la connexion ; la fermer complètement demanderait un relais
 *     sortant dédié, hors de portée ici.
 */

const INTERDITES = new BlockList();
// IPv4 : « ce réseau », privé, partagé (CGNAT), boucle, lien local, réservé
// aux tests et à la documentation, multidiffusion, réservé, diffusion.
for (const [adresse, prefixe] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  INTERDITES.addSubnet(adresse, prefixe, "ipv4");
}
// IPv6 : non spécifiée, boucle, IPv4 incorporée, documentation, privée (ULA),
// lien local, multidiffusion.
for (const [adresse, prefixe] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  INTERDITES.addSubnet(adresse, prefixe, "ipv6");
}

function adresseInterdite(ip: string): boolean {
  const famille = isIP(ip);
  if (famille === 4) return INTERDITES.check(ip, "ipv4");
  if (famille === 6) {
    // `::ffff:a.b.c.d` : on juge l'IPv4 qu'elle contient.
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    if (v4) return INTERDITES.check(v4, "ipv4");
    return INTERDITES.check(ip, "ipv6");
  }
  return true;
}

export type VerdictUrl = { ok: true; url: URL } | { ok: false; message: string };

/** Contrôle une adresse de webhook. Ne lève jamais. */
export async function verifierUrlWebhook(brute: string): Promise<VerdictUrl> {
  let url: URL;
  try {
    url = new URL(brute.trim());
  } catch {
    return { ok: false, message: "Adresse invalide." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "L'adresse du webhook doit commencer par https://." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "L'adresse ne doit pas contenir d'identifiant ni de mot de passe." };
  }

  const hote = url.hostname.replace(/^\[|\]$/g, "");
  let adresses: string[];
  try {
    adresses = isIP(hote)
      ? [hote]
      : (await lookup(hote, { all: true, verbatim: true })).map((r) => r.address);
  } catch {
    return { ok: false, message: `Le nom « ${url.hostname} » ne répond pas.` };
  }

  if (adresses.length === 0 || adresses.some(adresseInterdite)) {
    return {
      ok: false,
      message: "Cette adresse mène à un réseau privé. Le webhook doit être joignable sur Internet.",
    };
  }
  return { ok: true, url };
}
