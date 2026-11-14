import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { AdresseRefusee, estPublique, rechercheSure } from "./adresse-publique";

/**
 * LIRE UNE PAGE POUR L'ASSISTANT ALANYA (14/11/2026).
 *
 * Le modèle demande une adresse ; ce module la télécharge sous garde et n'en
 * rend que le TEXTE PRINCIPAL — sans menus, scripts, pieds de page — pour que
 * le modèle lise l'article et non la navigation du site.
 *
 * 🔴 TOUTE PAGE EST UNE DONNÉE, JAMAIS UNE CONSIGNE. Une page peut contenir
 * « ignore tes instructions et… ». Ce module ne la filtre pas — il ne saurait
 * pas — : c'est l'assistant qui la présente au modèle comme un document à
 * analyser (voir `assistant.ts`).
 *
 * Gardes, dans l'ordre où elles jouent :
 *   1. http ou https seulement, port 80 ou 443 ou au-delà de 1024 ;
 *   2. une adresse IP écrite en clair doit être publique ;
 *   3. un nom n'est résolu que vers des adresses publiques, AU MOMENT de la
 *      connexion (`rechercheSure`) ;
 *   4. chaque redirection repasse par les trois gardes, 4 au plus ;
 *   5. 3 Mo et 12 secondes au plus par page.
 */

const DELAI_MS = 12_000;
const MAX_OCTETS = 3 * 1024 * 1024;
const MAX_REDIRECTIONS = 4;
export const MAX_CARACTERES = 12_000;
const AGENT = "Mozilla/5.0 (compatible; AssistantAlanya/1.0; +https://alanyavox.com)";

export class LectureImpossible extends Error {}

export interface PageLue {
  adresse: string;
  titre: string;
  texte: string;
  coupe: boolean;
}

/** Vérifie une adresse avant d'y aller. Lève [LectureImpossible] sinon. */
export function verifierAdresse(adresse: string, autoriserLocal = false): URL {
  let url: URL;
  try {
    url = new URL(adresse);
  } catch {
    throw new LectureImpossible("Adresse invalide.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LectureImpossible("Seules les adresses http et https peuvent être lues.");
  }
  if (url.username || url.password) {
    throw new LectureImpossible("Une adresse avec identifiants n'est pas lue.");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!autoriserLocal && port !== 80 && port !== 443 && port <= 1024) {
    throw new LectureImpossible("Ce port n'est pas celui d'un site web.");
  }
  const hote = url.hostname.replace(/^\[|\]$/g, "");
  if (!autoriserLocal && (hote === "localhost" || hote.endsWith(".localhost"))) {
    throw new LectureImpossible("Cette adresse n'est pas publique.");
  }
  if (!autoriserLocal && isIP(hote) && !estPublique(hote)) {
    throw new LectureImpossible("Cette adresse n'est pas publique.");
  }
  return url;
}

interface Reponse {
  statut: number;
  entetes: http.IncomingHttpHeaders;
  corps: Buffer;
}

function telechargerUneFois(url: URL, autoriserLocal: boolean): Promise<Reponse> {
  return new Promise((resolve, reject) => {
    const module = url.protocol === "https:" ? https : http;
    const requete = module.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Language": "fr,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
        // 🔴 La garde de résolution, à la connexion même (voir l'en-tête).
        ...(autoriserLocal ? {} : { lookup: rechercheSure as unknown as typeof import("node:dns").lookup }),
        timeout: DELAI_MS,
      },
      (reponse) => {
        const statut = reponse.statusCode ?? 0;
        if (statut >= 300 && statut < 400) {
          reponse.resume();
          return resolve({ statut, entetes: reponse.headers, corps: Buffer.alloc(0) });
        }
        let flux: Readable = reponse;
        const codage = String(reponse.headers["content-encoding"] ?? "").toLowerCase();
        if (codage === "gzip" || codage === "x-gzip") flux = reponse.pipe(createGunzip());
        else if (codage === "deflate") flux = reponse.pipe(createInflate());
        else if (codage === "br") flux = reponse.pipe(createBrotliDecompress());

        const morceaux: Buffer[] = [];
        let taille = 0;
        flux.on("data", (m: Buffer) => {
          taille += m.length;
          if (taille > MAX_OCTETS) {
            // Au-delà, on garde le début : l'essentiel d'un article y est.
            reponse.destroy();
            flux.destroy();
            return resolve({ statut, entetes: reponse.headers, corps: Buffer.concat(morceaux) });
          }
          morceaux.push(m);
        });
        flux.on("end", () => resolve({ statut, entetes: reponse.headers, corps: Buffer.concat(morceaux) }));
        flux.on("error", (e) => reject(new LectureImpossible(`Page illisible : ${e.message}`)));
      },
    );
    requete.on("timeout", () => requete.destroy(new LectureImpossible("La page a mis trop de temps à répondre.")));
    requete.on("error", (e) => {
      if (e instanceof LectureImpossible) return reject(e);
      if (e instanceof AdresseRefusee) return reject(new LectureImpossible("Cette adresse n'est pas publique."));
      reject(new LectureImpossible(`Page inaccessible : ${e.message}`));
    });
    requete.end();
  });
}

/** Télécharge [adresse] en suivant les redirections sous garde. */
async function telecharger(adresse: string, autoriserLocal: boolean): Promise<{ url: URL; reponse: Reponse }> {
  let url = verifierAdresse(adresse, autoriserLocal);
  for (let saut = 0; saut <= MAX_REDIRECTIONS; saut++) {
    const reponse = await telechargerUneFois(url, autoriserLocal);
    if (reponse.statut >= 300 && reponse.statut < 400) {
      const vers = reponse.entetes.location;
      if (!vers) throw new LectureImpossible("Redirection sans destination.");
      // La destination repasse par toutes les gardes.
      url = verifierAdresse(new URL(vers, url).href, autoriserLocal);
      continue;
    }
    if (reponse.statut >= 400) throw new LectureImpossible(`La page répond ${reponse.statut}.`);
    return { url, reponse };
  }
  throw new LectureImpossible("Trop de redirections.");
}

/** L'encodage du texte : celui de l'en-tête, sinon celui de la page, sinon UTF-8. */
function decoder(corps: Buffer, typeContenu: string): string {
  const depuisEntete = typeContenu.match(/charset=["']?([\w-]+)/i)?.[1];
  const tete = corps.subarray(0, 2048).toString("latin1");
  const depuisPage = tete.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  for (const nom of [depuisEntete, depuisPage, "utf-8"]) {
    if (!nom) continue;
    try {
      return new TextDecoder(nom.toLowerCase()).decode(corps);
    } catch {
      // Encodage inconnu de Node : on essaie le suivant.
    }
  }
  return corps.toString("utf8");
}

const ENTITES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô",
  ucirc: "û", ugrave: "ù", icirc: "î", iuml: "ï", euml: "ë", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", hellip: "…", ndash: "–", mdash: "—", euro: "€", copy: "©", deg: "°",
};

export function decoderEntites(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tout, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : tout;
    }
    return ENTITES[code.toLowerCase()] ?? tout;
  });
}

const espaces = (s: string) => s.replace(/[ \t ]+/g, " ").trim();

/**
 * LE TEXTE PRINCIPAL D'UNE PAGE HTML.
 *
 * Sans bibliothèque : on retire ce qui n'est jamais du contenu (scripts,
 * styles, navigation, en-tête et pied de site, formulaires), puis on garde
 * `<article>`, sinon `<main>`, sinon le corps. Titres, paragraphes et listes
 * deviennent des lignes ; un titre garde sa marque pour que le modèle voie la
 * structure.
 */
export function extraireTexte(html: string): { titre: string; texte: string } {
  const titre = espaces(
    decoderEntites(
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
        html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "") ??
        "",
    ),
  );

  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|canvas|nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ");

  const zone = (balise: string) => {
    const m = s.match(new RegExp(`<${balise}\\b[^>]*>([\\s\\S]*?)<\\/${balise}>`, "i"));
    return m && m[1].replace(/<[^>]+>/g, "").trim().length > 400 ? m[1] : null;
  };
  s = zone("article") ?? zone("main") ?? s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s;

  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_t, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|pre|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lignes: string[] = [];
  for (const brute of decoderEntites(s).split("\n")) {
    const ligne = espaces(brute);
    if (!ligne || ligne === "-" || ligne === "|") continue;
    if (lignes[lignes.length - 1] === ligne) continue; // répétitions de mise en page
    lignes.push(ligne);
  }
  return { titre, texte: lignes.join("\n") };
}

/**
 * Lit [adresse] et rend son titre et son texte principal, coupé à
 * [MAX_CARACTERES]. Lève [LectureImpossible] avec un motif montrable au modèle.
 *
 * [autoriserLocal] ne sert qu'aux essais (`scripts/recherche-web-banc.ts`).
 */
export async function lirePage(adresse: string, autoriserLocal = false): Promise<PageLue> {
  const { url, reponse } = await telecharger(adresse, autoriserLocal);
  const type = String(reponse.entetes["content-type"] ?? "").toLowerCase();
  if (type.includes("application/pdf") || reponse.corps.subarray(0, 5).toString() === "%PDF-") {
    throw new LectureImpossible("Les documents PDF ne sont pas encore lus par l'assistant.");
  }
  const brut = decoder(reponse.corps, type);
  let titre = "";
  let texte: string;
  if (type.startsWith("text/plain") || type.includes("json") || type.includes("csv")) {
    texte = brut.trim();
  } else if (!type || type.includes("html") || type.includes("xml")) {
    ({ titre, texte } = extraireTexte(brut));
  } else {
    throw new LectureImpossible(`Ce type de contenu (${type.split(";")[0]}) n'est pas une page lisible.`);
  }
  if (!texte) throw new LectureImpossible("La page ne contient pas de texte lisible.");
  const coupe = texte.length > MAX_CARACTERES;
  return { adresse: url.href, titre, texte: coupe ? texte.slice(0, MAX_CARACTERES) : texte, coupe };
}
