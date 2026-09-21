import { type NextRequest, NextResponse } from "next/server";
import { ok, fail } from "@/lib/http";
import { requireUser, UnauthorizedError } from "@/lib/auth-context";
import { verifyAccessToken } from "@/lib/jwt";
import { readStored } from "@/modules/media/storage";
import { fluxZip, type EntreeArchive } from "@/lib/zip-flux";
import {
  assainir,
  chiffrerExport,
  estFamille,
  mediasAExporter,
  type Criteres,
  type Famille,
} from "@/lib/export-medias";

/**
 * L'EXPORT DES MÉDIAS REÇUS, EN UNE ARCHIVE.
 *
 * `GET /api/exports/medias?compter=1&…` → combien de fichiers, quel poids
 * `GET /api/exports/medias?…`           → l'archive elle-même, en flux
 *
 * Paramètres communs :
 *   `familles`      photo,video,audio,document — au moins une
 *   `conversations` identifiants séparés par des virgules ; absent = toutes
 *   `du`, `au`      bornes ISO 8601 ; absentes = depuis toujours / jusqu'à
 *
 * 🔴 UN SEUL APPEL, ET PAS DE TÂCHE DE FOND. Une file d'attente aurait demandé
 * une table, un ouvrier, un ménage des vieilles archives et un quota de disque —
 * pour un résultat que le navigateur sait déjà faire. Un téléchargement lancé
 * survit à la navigation dans l'application, affiche sa progression et prévient
 * à la fin : tout ce qu'une file aurait dû réimplémenter, en moins fiable.
 *
 * ⚠️ RIEN N'EST ÉCRIT SUR LE DISQUE DU SERVEUR. L'archive n'existe à aucun
 * moment en entier : elle se fabrique octet par octet vers le client. Deux cents
 * exports simultanés d'un gigaoctet ne coûtent donc pas deux cents gigaoctets.
 */

/** Au-delà, on refuse : c'est le signe d'une sélection trop large. */
const PLAFOND_OCTETS = 8 * 1024 * 1024 * 1024;

/**
 * Qui demande ?
 *
 * ⚠️ LE JETON PEUT VENIR DE L'URL, et il le faut : un téléchargement de
 * navigateur — `<a download>`, une nouvelle fenêtre — ne porte AUCUN en-tête
 * qu'on choisit. Sans ce chemin, l'export ne pourrait se faire que par `fetch`,
 * donc en mémoire dans la page, donc avec un plafond de quelques centaines de
 * mégaoctets. Même règle que `/api/media/:id`, qui a le même besoin.
 */
function demandeur(req: NextRequest): string {
  try {
    return requireUser(req).sub;
  } catch {
    const jeton = req.nextUrl.searchParams.get("token");
    if (jeton) {
      const charge = verifyAccessToken(jeton);
      if (charge.scope === "access") return charge.sub;
    }
    throw new UnauthorizedError("Token manquant ou invalide");
  }
}

/** Une date ISO, ou `null`. Une date illisible est refusée, pas ignorée. */
function lireDate(brut: string | null): Date | null | "invalide" {
  if (!brut || brut.trim() === "") return null;
  const d = new Date(brut);
  return Number.isNaN(d.getTime()) ? "invalide" : d;
}

function lireCriteres(req: NextRequest): Criteres | { erreur: string } {
  const p = req.nextUrl.searchParams;

  const familles = (p.get("familles") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  if (familles.length === 0) return { erreur: "Choisissez au moins un type de média" };
  if (!familles.every(estFamille)) return { erreur: "Type de média inconnu" };

  const du = lireDate(p.get("du"));
  const au = lireDate(p.get("au"));
  if (du === "invalide" || au === "invalide") return { erreur: "Date invalide" };
  // Une période à l'envers ne rendrait jamais rien, et personne ne comprendrait
  // pourquoi : on le dit au lieu de livrer une archive vide.
  if (du && au && du.getTime() > au.getTime()) {
    return { erreur: "La date de début est après la date de fin" };
  }

  const conversations = (p.get("conversations") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");

  return { conversations, familles: familles as Famille[], du, au };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = demandeur(req);
  } catch {
    return fail("Non authentifié", 401, "UNAUTHORIZED");
  }

  const criteres = lireCriteres(req);
  if ("erreur" in criteres) return fail(criteres.erreur, 400, "BAD_FILTER");

  // ── Le décompte, avant de s'engager ────────────────────────────────────
  if (req.nextUrl.searchParams.get("compter") !== null) {
    const { fichiers, octets } = await chiffrerExport(userId, criteres);
    return ok({ fichiers, octets, plafondOctets: PLAFOND_OCTETS });
  }

  /*
   * ⚠️ LE PLAFOND EST VÉRIFIÉ AVANT D'OUVRIR LE FLUX, et c'est le seul moment où
   * l'on peut encore répondre proprement. Une fois le premier octet parti, le
   * navigateur a commencé son téléchargement : une erreur survenue là n'arrive
   * plus à l'écran, elle laisse un fichier à moitié écrit.
   */
  const { fichiers, octets } = await chiffrerExport(userId, criteres);
  if (fichiers === 0) return fail("Aucun média ne correspond", 404, "EMPTY_EXPORT");
  if (octets > PLAFOND_OCTETS) {
    return fail("Sélection trop large — réduisez la période", 413, "TOO_LARGE");
  }

  const source = (async function* (): AsyncGenerator<EntreeArchive> {
    /*
     * ⚠️ LES NOMS SONT DÉDOUBLONNÉS DANS L'ARCHIVE. Deux photos nommées
     * « IMG_0042.jpg » reçues le même jour dans la même discussion existent
     * parfaitement ; deux entrées de même chemin dans un ZIP donnent une
     * archive que les logiciels extraient à moitié, ou écrasent en silence.
     */
    const vus = new Set<string>();

    for await (const media of mediasAExporter(userId, criteres)) {
      let donnees: Buffer;
      try {
        donnees = await readStored(media.url);
      } catch {
        /*
         * ⚠️ UN FICHIER MANQUANT NE FAIT PAS ÉCHOUER L'EXPORT. Le binaire a pu
         * disparaître du stockage alors que la ligne existe encore. Abandonner
         * tout l'export pour un fichier perdu ferait perdre les neuf cent
         * quatre-vingt-dix-neuf autres.
         */
        continue;
      }

      const horodate = media.createdAt
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
        .replace(/:/g, "-");
      const base = assainir(media.filename || media.id);
      let chemin = `${media.dossier}/${horodate} ${base}`;
      if (vus.has(chemin)) {
        const point = base.lastIndexOf(".");
        const corps = point > 0 ? base.slice(0, point) : base;
        const suffixe = point > 0 ? base.slice(point) : "";
        chemin = `${media.dossier}/${horodate} ${corps} (${media.id.slice(0, 6)})${suffixe}`;
      }
      vus.add(chemin);

      yield { chemin, donnees, date: media.createdAt, mime: media.mimeType };
    }
  })();

  const jour = new Date().toISOString().slice(0, 10);
  return new NextResponse(fluxZip(source), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      // ⚠️ PAS DE `Content-Length` : la taille finale n'est connue qu'une fois
      // la dernière entrée écrite. L'annoncer à l'avance — même la somme des
      // tailles — mentirait, l'archive portant ses propres en-têtes, et le
      // navigateur couperait le téléchargement en le croyant terminé.
      "Content-Disposition": `attachment; filename="alanya-medias-${jour}.zip"`,
      // Un export est daté : le rejouer depuis un cache donnerait l'archive
      // d'hier pour la demande d'aujourd'hui.
      "Cache-Control": "no-store",
      // Sans cela, un proxy peut mettre l'archive en tampon en entier avant de
      // la transmettre — ce qui annule tout l'intérêt du flux.
      "X-Accel-Buffering": "no",
    },
  });
}
