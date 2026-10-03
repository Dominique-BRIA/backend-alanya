import { type NextRequest, NextResponse } from "next/server";
import { fail } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-context";
import { verifyAccessToken } from "@/lib/jwt";
import { urlBipEnregistrement } from "@/lib/ivr.mjs";

/**
 * LES SONS DU STANDARD, RELAYÉS POUR LE NAVIGATEUR.
 *
 * GET /api/ivr/son?u=<adresse du son>&token=<jeton>
 *
 * 🐛 « LE WEB NE SUIT AUCUN AUDIO QUAND ON APPELLE UN CENTRE D'APPELS OU UN
 * CENTRE VOCAL » (user, 03/10/2026). Les invites, musiques d'attente et sons
 * des touches vivent sur le serveur de la plateforme de l'équipe, pas ici :
 *
 *   · `https://open.alanya.cloud/…` — refusé par la CSP du web, dont
 *     `media-src` n'autorise que sa propre origine et les seaux B2 ;
 *   · `http://158.220.107.211:9010/…` — en HTTP clair : une page HTTPS n'a
 *     PAS LE DROIT de le lire (contenu mixte), quelle que soit la CSP.
 *
 * Le navigateur refusait donc en silence. Le téléphone, lui, n'a ni CSP ni
 * règle de contenu mixte : il entendait tout.
 *
 * ⚠️ PAS UN RELAIS OUVERT. Seuls passent les hôtes que la plateforme
 * référence ELLE-MÊME : `VOCAL_BASE_URL`, les `company.url_serveur`, et les
 * adresses absolues rangées dans `vocal`, `center_music`, `center_audio`.
 * Toute autre adresse est refusée — sans quoi ce serveur irait chercher
 * n'importe quoi, n'importe où, pour n'importe qui (SSRF).
 *
 * ⚠️ AUTHENTIFIÉ, par en-tête OU par `?token=` : un élément `<audio>` ne sait
 * pas envoyer d'en-tête. Même règle que `/api/media/:id`.
 */

/** Les hôtes autorisés, relus au plus toutes les 5 minutes. */
let hotes: { valeurs: Set<string>; lu: number } | null = null;
const DUREE_HOTES_MS = 5 * 60 * 1000;

function origine(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function hotesAutorises(): Promise<Set<string>> {
  if (hotes && Date.now() - hotes.lu < DUREE_HOTES_MS) return hotes.valeurs;
  const valeurs = new Set<string>();
  const ajoute = (u: string | null | undefined) => {
    const o = origine(u);
    if (o) valeurs.add(o);
  };
  ajoute(process.env.VOCAL_BASE_URL);
  ajoute(urlBipEnregistrement());
  const [entreprises, vocaux, musiques, audios] = await Promise.all([
    prisma.company.findMany({ where: { urlServeur: { not: null } }, select: { urlServeur: true } }),
    prisma.vocal.findMany({ select: { urlVocal: true } }),
    prisma.centerMusic.findMany({ select: { urlMusic: true } }),
    prisma.centerAudio.findMany({ select: { urlAudio: true } }),
  ]);
  entreprises.forEach((e) => ajoute(e.urlServeur));
  vocaux.forEach((v) => ajoute(v.urlVocal));
  musiques.forEach((m) => ajoute(m.urlMusic));
  audios.forEach((a) => ajoute(a.urlAudio));
  hotes = { valeurs, lu: Date.now() };
  return valeurs;
}

function utilisateur(req: NextRequest): string | null {
  try {
    return requireUser(req).sub;
  } catch {
    const token = req.nextUrl.searchParams.get("token");
    if (!token) return null;
    try {
      const p = verifyAccessToken(token);
      return p.scope === "access" ? p.sub : null;
    } catch {
      return null;
    }
  }
}

/**
 * Le type annoncé par la plateforme n'est pas fiable : ses enregistrements
 * `.mpeg` sont des MP3 (en-tête `ff f3`, encodeur LAME) servis en
 * `video/mpeg`, qu'un navigateur peut refuser dans un `<audio>`.
 */
function typeAudio(chemin: string, annonce: string | null): string {
  const ext = chemin.toLowerCase().split(".").pop() ?? "";
  if (ext === "mp3" || ext === "mpeg" || ext === "mpga") return "audio/mpeg";
  if (ext === "ogg" || ext === "oga" || ext === "opus") return "audio/ogg";
  if (ext === "wav") return "audio/wav";
  if (ext === "m4a" || ext === "aac") return "audio/mp4";
  if (ext === "webm") return "audio/webm";
  return annonce && annonce.startsWith("audio/") ? annonce : "audio/mpeg";
}

export async function GET(req: NextRequest) {
  if (!utilisateur(req)) return fail("Token manquant ou invalide", 401, "UNAUTHORIZED");

  const brut = req.nextUrl.searchParams.get("u") ?? "";
  const o = origine(brut);
  if (!o || !(await hotesAutorises()).has(o)) {
    return fail("Adresse de son non autorisée", 403, "SON_NON_AUTORISE");
  }

  // Le `Range` suit : le navigateur s'en sert pour connaître la durée et
  // reboucler une musique d'attente sans tout retélécharger.
  const range = req.headers.get("range");
  let amont: Response;
  try {
    amont = await fetch(brut, {
      headers: range ? { range } : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fail("Le serveur des sons ne répond pas", 502, "SON_INJOIGNABLE");
  }
  if (!amont.ok || !amont.body) {
    return fail("Son introuvable", amont.status === 404 ? 404 : 502, "SON_INTROUVABLE");
  }

  const entetes = new Headers({
    "Content-Type": typeAudio(new URL(brut).pathname, amont.headers.get("content-type")),
    // Un son de standard change rarement ; le navigateur peut le garder.
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  });
  for (const nom of ["content-length", "content-range"]) {
    const v = amont.headers.get(nom);
    if (v) entetes.set(nom, v);
  }
  return new NextResponse(amont.body, { status: amont.status, headers: entetes });
}
