import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/**
 * UNE ADRESSE D'INTERNET, ET RIEN D'AUTRE (14/11/2026, recherche web de
 * l'Assistant Alanya).
 *
 * 🔴 POURQUOI. L'assistant demande à NOTRE serveur de lire une page dont
 * l'adresse vient du modèle — donc, au fond, de n'importe qui : un utilisateur
 * peut écrire « lis http://127.0.0.1:3000/api/admin/… », ou une page lue peut
 * contenir un lien piégé. Sans garde, le serveur irait lire sa propre API, la
 * base Redis, ou le réseau interne d'OVH, et en recopierait le contenu dans la
 * conversation.
 *
 * ⚠️ LA VÉRIFICATION SE FAIT À LA CONNEXION, PAS AVANT. Vérifier le nom puis
 * laisser `fetch` le résoudre à nouveau laisserait une fenêtre : un domaine
 * peut répondre « adresse publique » à la vérification et « 127.0.0.1 » une
 * milliseconde plus tard (« DNS rebinding »). [rechercheSure] est donc passée
 * comme `lookup` à la requête elle-même : l'adresse contrôlée est celle à
 * laquelle on se connecte.
 */

/** Vrai si [ip] (v4 ou v6) est une adresse publique d'Internet. */
export function estPublique(ip: string): boolean {
  const famille = isIP(ip);
  if (famille === 4) return v4Publique(ip);
  if (famille === 6) return v6Publique(ip);
  return false;
}

function octets4(ip: string): number[] {
  return ip.split(".").map((x) => Number(x));
}

function v4Publique(ip: string): boolean {
  const [a, b, c] = octets4(ip);
  if (a === 0 || a === 10 || a === 127) return false; // « ce réseau », privé, boucle
  if (a === 100 && b >= 64 && b <= 127) return false; // partagé des opérateurs (CGNAT)
  if (a === 169 && b === 254) return false; // lien local, dont 169.254.169.254 (métadonnées)
  if (a === 172 && b >= 16 && b <= 31) return false; // privé
  if (a === 192 && b === 168) return false; // privé
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // réservé, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // essais de performance
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multidiffusion, réservé, diffusion
  return true;
}

/** Les 8 groupes de 16 bits d'une adresse v6, `null` si illisible. */
function groupes6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Fin en notation v4 (« ::ffff:1.2.3.4 ») : on la convertit en deux groupes.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = octets4(v4[1]);
    s = s.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const moities = s.split("::");
  if (moities.length > 2) return null;
  const avant = moities[0] ? moities[0].split(":") : [];
  const apres = moities.length === 2 && moities[1] ? moities[1].split(":") : [];
  const manquants = 8 - avant.length - apres.length;
  if (manquants < 0 || (moities.length === 1 && manquants !== 0)) return null;
  const tous = [...avant, ...Array(moities.length === 2 ? manquants : 0).fill("0"), ...apres];
  const nombres = tous.map((g) => parseInt(g, 16));
  return nombres.length === 8 && nombres.every((n) => n >= 0 && n <= 0xffff) ? nombres : null;
}

function v6Publique(ip: string): boolean {
  const g = groupes6(ip);
  if (!g) return false;
  const v4Embarquee = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // v4 dans v6 (« ::ffff:a.b.c.d », « ::a.b.c.d ») et NAT64 (64:ff9b::/96) :
  // c'est l'adresse v4 qui compte.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return v4Publique(v4Embarquee());
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4Publique(v4Embarquee());
  }
  if ((g[0] & 0xfe00) === 0xfc00) return false; // locale unique (fc00::/7)
  if ((g[0] & 0xffc0) === 0xfe80) return false; // lien local
  if ((g[0] & 0xff00) === 0xff00) return false; // multidiffusion
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

export class AdresseRefusee extends Error {}

/**
 * Remplace la résolution de noms de Node pour une requête : ne rend QUE des
 * adresses publiques, et échoue si le nom n'en a aucune.
 *
 * Signature de `dns.lookup`, telle que `http.request({ lookup })` l'appelle.
 */
export function rechercheSure(
  nom: string,
  options: { all?: boolean } | number,
  rappel: (err: NodeJS.ErrnoException | null, adresse: string | LookupAddress[], famille?: number) => void,
): void {
  dnsLookup(nom, { all: true }, (err, adresses) => {
    if (err) return rappel(err, "", 0);
    const publiques = (adresses as LookupAddress[]).filter((a) => estPublique(a.address));
    if (publiques.length === 0) {
      return rappel(new AdresseRefusee(`${nom} ne mène pas à une adresse publique`), "", 0);
    }
    if (typeof options === "object" && options.all) return rappel(null, publiques);
    rappel(null, publiques[0].address, publiques[0].family);
  });
}
